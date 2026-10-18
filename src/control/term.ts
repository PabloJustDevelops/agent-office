/*
 * The server's copy of a session's screen. Every PTY byte goes through a
 * headless xterm (3000 lines of scrollback) on its way to the browsers, which
 * buys three things:
 *
 *   - replay: a browser that connects late, or reconnects, gets the serialized
 *     screen first (alt buffer and modes included, so bracketed paste and
 *     application cursor keys still work), then live bytes, with no gap and
 *     no duplicate;
 *   - query answers: a TUI asks its terminal for the cursor position or its
 *     device attributes at start, and with no browser open nobody would
 *     answer. The headless terminal answers into the PTY itself, and the same
 *     kind of answer arriving from a browser shortly after is dropped, so the
 *     agent never reads two;
 *   - one frame per 16 ms per viewer, at most 64 KB raw, instead of one per
 *     read.
 */
import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { clampSize } from "./pty.ts";
import { SCROLLBACK_LINES, type Disposable, type TermSink } from "./types.ts";

export const FRAME_MS = 16;
export const FRAME_MAX = 64 * 1024;
/** A browser's answer of a kind the headless terminal answered this recently is dropped. */
export const REPLY_DEDUP_MS = 2_000;

/** Terminal answers, by kind. The headless terminal answers CPR, DA1, DA2, DSR and DECRPM; the others pass through from a browser. */
const REPLIES: { kind: string; re: RegExp }[] = [
  { kind: "cpr", re: /\x1b\[\d+;\d+R/g },
  { kind: "da1", re: /\x1b\[\?[\d;]*c/g },
  { kind: "da2", re: /\x1b\[>[\d;]*c/g },
  { kind: "dsr", re: /\x1b\[0n/g },
  { kind: "decrpm", re: /\x1b\[\??\d+;\d+\$y/g },
  { kind: "xtversion", re: /\x1bP>\|[^\x1b]*\x1b\\/g },
  { kind: "osc-color", re: /\x1b\]1[01];rgb:[^\x07\x1b]*(?:\x07|\x1b\\)/g },
  { kind: "kitty", re: /\x1b\[\?\d+u/g },
];

export function replyKinds(s: string): string[] {
  const out: string[] = [];
  for (const { kind, re } of REPLIES) {
    re.lastIndex = 0;
    if (re.test(s)) out.push(kind);
  }
  return out;
}

interface Viewer {
  sink: TermSink;
  queue: Uint8Array[];
  queued: number;
  /** Waiting for the replay: live bytes collect in queue meanwhile. */
  replaying: boolean;
  exitAfterReplay: boolean;
}

export interface TermBufferOptions {
  cols: number;
  rows: number;
  /** Bytes the terminal answers with, for the PTY (query replies). */
  reply(data: string): void;
  now?: () => number;
  scrollback?: number;
}

export class TermBuffer {
  private readonly term: Terminal;
  private readonly ser: SerializeAddon;
  private readonly viewers = new Set<Viewer>();
  private readonly answered = new Map<string, number>();
  private readonly now: () => number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private exitCode: number | null | undefined = undefined;
  private disposed = false;
  private bytes = 0;

  constructor(private readonly o: TermBufferOptions) {
    this.now = o.now ?? Date.now;
    const { cols, rows } = clampSize(o.cols, o.rows);
    this.term = new Terminal({ cols, rows, scrollback: o.scrollback ?? SCROLLBACK_LINES, allowProposedApi: true });
    this.ser = new SerializeAddon();
    this.term.loadAddon(this.ser as any);
    this.term.onData((d: string) => {
      if (this.disposed || this.exitCode !== undefined) return;
      const t = this.now();
      for (const k of replyKinds(d)) this.answered.set(k, t);
      this.o.reply(d);
    });
  }

  /** Total PTY bytes seen. */
  get size(): number {
    return this.bytes;
  }

  get cols(): number {
    return this.term.cols;
  }

  get rows(): number {
    return this.term.rows;
  }

  /** The app asked for bracketed paste (ESC[?2004h). */
  get bracketedPaste(): boolean {
    return this.term.modes.bracketedPasteMode;
  }

  get exited(): boolean {
    return this.exitCode !== undefined;
  }

  /** A chunk from the PTY. */
  write(chunk: Uint8Array): void {
    if (this.disposed || !chunk.length) return;
    this.bytes += chunk.length;
    this.term.write(chunk);
    for (const v of this.viewers) {
      v.queue.push(chunk);
      v.queued += chunk.length;
    }
    this.schedule();
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const s = clampSize(cols, rows);
    if (s.cols !== this.term.cols || s.rows !== this.term.rows) this.term.resize(s.cols, s.rows);
  }

  /**
   * Browser keystrokes on their way to the PTY: answers to terminal queries
   * the headless terminal already gave are taken out.
   */
  filterInput(data: string): string {
    if (!data.includes("\x1b")) return data;
    const t = this.now();
    let out = data;
    for (const { kind, re } of REPLIES) {
      const at = this.answered.get(kind);
      if (at === undefined || t - at > REPLY_DEDUP_MS) continue;
      re.lastIndex = 0;
      out = out.replace(re, "");
    }
    return out;
  }

  /** Replay (serialized screen + scrollback), then live bytes, then exit. */
  attach(sink: TermSink): Disposable {
    if (this.disposed) {
      sink.exit(this.exitCode ?? null);
      return { dispose() {} };
    }
    const v: Viewer = { sink, queue: [], queued: 0, replaying: true, exitAfterReplay: false };
    this.viewers.add(v);
    // The callback runs once every byte written before it is parsed, and before any byte written after it.
    this.term.write("", () => {
      if (!this.viewers.has(v)) return;
      let screen = "";
      try {
        screen = this.ser.serialize({ scrollback: this.o.scrollback ?? SCROLLBACK_LINES });
      } catch {
        screen = "";
      }
      v.replaying = false;
      if (screen) this.send(v, Buffer.from(screen, "utf8"));
      this.flushOne(v);
      if (v.exitAfterReplay || this.exitCode !== undefined) this.finish(v);
    });
    return { dispose: () => void this.viewers.delete(v) };
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  /** The program ended: viewers get what's left, then exit. The screen stays replayable. */
  exit(code: number | null): void {
    if (this.exitCode !== undefined) return;
    this.exitCode = code;
    for (const v of this.viewers) {
      if (v.replaying) v.exitAfterReplay = true;
      else {
        this.flushOne(v);
        this.finish(v);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    if (this.exitCode === undefined) this.exit(null);
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.viewers.clear();
    this.term.dispose();
  }

  /** The visible screen as plain text, for tests and diagnostics. `unwrap`: a line the terminal wrapped comes back whole (a long URL). */
  screen(o: { unwrap?: boolean } = {}): Promise<string> {
    return new Promise((resolve) =>
      this.term.write("", () => {
        const b = this.term.buffer.active;
        const lines: string[] = [];
        for (let y = 0; y < this.term.rows; y++) {
          const line = b.getLine(b.viewportY + y);
          if (o.unwrap && y > 0 && line?.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
          else lines.push(line?.translateToString(true) ?? "");
        }
        for (let i = 0; i < lines.length; i++) lines[i] = lines[i]!.trimEnd();
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        resolve(lines.join("\n"));
      }),
    );
  }

  private finish(v: Viewer): void {
    this.viewers.delete(v);
    try {
      v.sink.exit(this.exitCode ?? null);
    } catch {
      // The viewer went away.
    }
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const v of this.viewers) if (!v.replaying) this.flushOne(v);
    }, FRAME_MS);
  }

  private flushOne(v: Viewer): void {
    if (!v.queued) return;
    const all = v.queue.length === 1 ? v.queue[0]! : Buffer.concat(v.queue);
    v.queue = [];
    v.queued = 0;
    for (let i = 0; i < all.length; i += FRAME_MAX) this.send(v, all.subarray(i, i + FRAME_MAX));
  }

  private send(v: Viewer, chunk: Uint8Array): void {
    try {
      v.sink.data(chunk);
    } catch {
      this.viewers.delete(v);
    }
  }
}
