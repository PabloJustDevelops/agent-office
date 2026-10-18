/*
 * What the three chat adapters share: the ChatConn listener plumbing, item
 * throttling and scrubbing, JSON-lines framing, and a local child on pipes.
 *
 * Chat mode is the one place prompt and reply text reaches the browser, and
 * only an unlocked one. Even so every text goes through redactSecrets, so a
 * key an agent prints doesn't land on a screen recording, and tool calls
 * carry the office's redacted labels, never their raw input.
 */
import { spawn } from "node:child_process";
import type { Approval, ApprovalAnswer, ChatItem } from "../../shared/control.ts";
import { redactSecrets } from "../../ingest/redact.ts";
import { Emitter, Latch } from "../emitter.ts";
import { ControlError, type ChatConn, type Disposable, type PipeProc, type TermExit } from "../types.ts";
import { exitOf } from "../pty.ts";

export const TEXT_MAX = 64 * 1024;
/** At most 8 updates a second per streaming item. */
export const ITEM_MIN_MS = 125;

export function scrubChat(text: string): string {
  const t = text.length > TEXT_MAX ? text.slice(0, TEXT_MAX) + "\n…" : text;
  return redactSecrets(t);
}

export function approvalItem(a: Approval, text: string): ChatItem {
  return { id: `ap-${a.id}`, kind: "approval", tool: a.tool, ...(a.category ? { category: a.category } : {}), summary: a.summary, ...(a.detail ? { detail: a.detail } : {}), text, at: a.at };
}

export const APPROVAL_TEXT = {
  open: "Waiting for you",
  allowed: "Allowed",
  always: "Allowed for this session",
  denied: "Denied",
  withdrawn: "Answered elsewhere",
  interrupted: "Interrupted",
} as const;

/** Short, single-line, scrubbed: for error and system items built from an agent's message. */
export function shortReason(text: unknown, max = 300): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return redactSecrets(s.length > max ? s.slice(0, max - 1) + "…" : s);
}

export abstract class ChatBase implements ChatConn {
  protected readonly items = new Emitter<ChatItem>();
  protected readonly approvals = new Emitter<Approval | null>();
  protected readonly turns = new Emitter<"busy" | "idle">();
  protected readonly ids = new Emitter<string>();
  protected readonly exit = new Latch<TermExit>();
  protected sessionId: string | undefined;
  private busy = false;
  private readonly last = new Map<string, { at: number; timer?: ReturnType<typeof setTimeout>; item?: ChatItem }>();
  private seq = 0;

  constructor(protected readonly now: () => number = Date.now) {}

  get agentSessionId(): string | undefined {
    return this.sessionId;
  }

  abstract send(text: string): Promise<void>;
  abstract interrupt(): Promise<void>;
  abstract answer(a: ApprovalAnswer): Promise<void>;
  abstract stop(): Promise<void>;

  onItem(fn: (it: ChatItem) => void): Disposable {
    return this.items.on(fn);
  }
  onApproval(fn: (a: Approval | null) => void): Disposable {
    return this.approvals.on(fn);
  }
  onTurn(fn: (state: "busy" | "idle") => void): Disposable {
    return this.turns.on(fn);
  }
  onSessionId(fn: (id: string) => void): Disposable {
    if (this.sessionId) {
      const id = this.sessionId;
      queueMicrotask(() => fn(id));
    }
    return this.ids.on(fn);
  }
  onExit(fn: (e: TermExit) => void): Disposable {
    return this.exit.on(fn);
  }

  protected iso(): string {
    return new Date(this.now()).toISOString();
  }

  protected nextId(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  protected setSessionId(id: string): void {
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
    this.ids.emit(id);
  }

  protected setBusy(busy: boolean): void {
    if (busy === this.busy) return;
    this.busy = busy;
    this.turns.emit(busy ? "busy" : "idle");
  }

  protected get isBusy(): boolean {
    return this.busy;
  }

  /** Emit an item now (final), flushing any throttled version of it first. */
  protected put(item: ChatItem): void {
    const it = item.text !== undefined ? { ...item, text: scrubChat(item.text) } : item;
    const l = this.last.get(it.id);
    if (l?.timer) clearTimeout(l.timer);
    this.last.set(it.id, { at: this.now() });
    if (this.last.size > 600) this.last.delete(this.last.keys().next().value!);
    this.items.emit(it);
  }

  /** Emit a streaming update, at most ITEM_MIN_MS apart per id; the latest version always arrives. */
  protected stream(item: ChatItem): void {
    const l = this.last.get(item.id);
    const t = this.now();
    if (!l || t - l.at >= ITEM_MIN_MS) return this.put(item);
    l.item = item;
    if (l.timer) return;
    l.timer = setTimeout(() => {
      const cur = this.last.get(item.id);
      if (cur?.item) this.put(cur.item);
    }, ITEM_MIN_MS - (t - l.at));
  }

  protected system(text: string, kind: "system" | "error" = "system"): void {
    this.put({ id: this.nextId(kind === "error" ? "err" : "sys"), kind, text, at: this.iso() });
  }

  protected user(text: string): void {
    this.put({ id: this.nextId("u"), kind: "user", text, at: this.iso() });
  }

  protected finished(e: TermExit): void {
    for (const l of this.last.values()) if (l.timer) clearTimeout(l.timer);
    this.setBusy(false);
    this.exit.fire(e);
  }
}

/** JSON lines from a byte stream: one parsed object per complete line, junk skipped. */
export function jsonLines(fn: (msg: any) => void): (chunk: Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = "";
  return (chunk) => {
    buf += dec.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line || line[0] !== "{") continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && typeof msg === "object") fn(msg);
    }
    if (buf.length > 32 << 20) buf = "";
  };
}

/** Keep the last few KB of stderr, for a short reason when the agent dies early. */
export function tailOf(max = 2048): { push(d: Uint8Array): void; text(): string } {
  let s = "";
  return {
    push(d) {
      s = (s + Buffer.from(d).toString("utf8")).slice(-max);
    },
    text: () => s,
  };
}

/** A local child on plain pipes, as a PipeProc. */
/**
 * A local child on pipes, leading its own process group. With `watchdog`,
 * a tiny sh beside it ends that group if the office itself dies without its
 * shutdown (SIGKILL, a crash): for agents that don't stop when their stdin
 * closes (opencode serve), which would otherwise keep running, logged in,
 * on their loopback port.
 */
export function localPipe(file: string, args: string[], cwd: string, env: Record<string, string>, o: { watchdog?: boolean } = {}): Promise<PipeProc> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    if (o.watchdog) watch(child.pid);
    const out = new Emitter<Uint8Array>();
    const err = new Emitter<Uint8Array>();
    const exit = new Latch<TermExit>();
    let started = false;
    child.stdout!.on("data", (d: Buffer) => out.emit(d));
    child.stderr!.on("data", (d: Buffer) => err.emit(d));
    child.stdin!.on("error", () => {});
    child.on("error", (e) => {
      if (!started) reject(new ControlError(500, `Could not start ${file.split("/").pop()}: ${(e as NodeJS.ErrnoException).code ?? "error"}`));
      exit.fire({ code: 127 });
    });
    child.on("exit", (code, signal) => exit.fire(exitOf(code, signal)));
    child.on("spawn", () => {
      started = true;
      resolve({
        pid: child.pid,
        write: (d) => {
          if (!exit.fired && child.stdin!.writable) child.stdin!.write(d);
        },
        end: () => {
          if (child.stdin!.writable) child.stdin!.end();
        },
        onStdout: (fn) => out.on(fn),
        onStderr: (fn) => err.on(fn),
        onExit: (fn) => exit.on(fn),
        kill: (sig = "SIGTERM") => {
          if (exit.fired || !child.pid) return;
          try {
            // detached: the child leads its own group, so this reaches what it started too.
            process.kill(sig === "SIGKILL" ? -child.pid : child.pid, sig);
          } catch {
            try {
              child.kill(sig);
            } catch {
              // Already gone.
            }
          }
        },
      });
    });
  });
}

const WATCHDOG = 'while kill -0 "$1" 2>/dev/null && kill -0 "$2" 2>/dev/null; do sleep 2; done; kill -0 "$1" 2>/dev/null || kill -s TERM -- "-$2" 2>/dev/null; exit 0';

/** Ends process group `pid` within ~2 s of this process dying; goes away by itself when that group's leader exits. */
function watch(pid: number | undefined): void {
  if (!pid || process.platform === "win32") return;
  try {
    const dog = spawn("/bin/sh", ["-c", WATCHDOG, "agentoffice-watchdog", String(process.pid), String(pid)], { stdio: "ignore", detached: true });
    dog.on("error", () => {});
    dog.unref();
  } catch {
    // No sh: the office's own shutdown still ends it.
  }
}

/** stdin closed, then SIGTERM, then SIGKILL: resolves once the process is gone. */
export function endGracefully(p: PipeProc, o: { endStdin: boolean; termAfterMs: number; killAfterMs: number }): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    p.onExit(() => {
      done = true;
      for (const t of timers) clearTimeout(t);
      resolve();
    });
    if (o.endStdin) p.end();
    else p.kill("SIGTERM");
    timers.push(
      setTimeout(() => !done && p.kill("SIGTERM"), o.termAfterMs),
      setTimeout(() => !done && p.kill("SIGKILL"), o.termAfterMs + o.killAfterMs),
      setTimeout(() => !done && resolve(), o.termAfterMs + o.killAfterMs + 2000),
    );
    for (const t of timers) t.unref?.();
  });
}
