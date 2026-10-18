/*
 * A session's real terminal: xterm.js attached to the agent's PTY on the
 * server. Output arrives base64 on the term stream (scrollback first, so a
 * reconnect starts from a clean screen); keystrokes go to /input in order,
 * coalesced per tick; the size follows the panel and is sent to /resize.
 * One PTY can have several viewers (a desktop and a phone): it takes the size
 * of the one in use, so a view re-sends its size when its stream (re)opens,
 * when it gets the focus or comes back into view, and when it types after a
 * pause, even if its own size never changed.
 * xterm's DOM renderer injects <style> elements and colour style attributes,
 * which is why the page's CSP allows inline styles (scripts stay 'self').
 */
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { adoptCss } from "../dom.ts";
import { api, stream, termPath, type Stream, type StreamState } from "./api.ts";

/** The office palette: near-black glass, warm off-white, the brand-ish ANSI colours. */
const THEME: ITheme = {
  background: "#0b0b10",
  foreground: "#e6e3dc",
  cursor: "#eceae4",
  cursorAccent: "#0b0b10",
  selectionBackground: "rgba(255, 255, 255, 0.22)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.22)",
  black: "#16161d",
  red: "#ff6b62",
  green: "#4ade80",
  yellow: "#ffb547",
  blue: "#7aa2ff",
  magenta: "#c49bff",
  cyan: "#5fd4d0",
  white: "#d8d5ce",
  brightBlack: "#5c5c66",
  brightRed: "#ff8f87",
  brightGreen: "#86efac",
  brightYellow: "#ffd089",
  brightBlue: "#a5c0ff",
  brightMagenta: "#dcc2ff",
  brightCyan: "#9be8e5",
  brightWhite: "#f6f4ef",
};

let cssDone = false;

export interface TermView {
  el: HTMLElement;
  focus(): void;
  /** Re-fit to the container (after it is shown or resized). */
  fit(): void;
  /** Stops input, keeps the screen (the agent exited). */
  freeze(note: string): void;
  dispose(): void;
}

export function createTerminal(sessionId: string, opts: { onExit?(code: number | undefined): void; onState?(s: StreamState, err?: string): void } = {}): TermView {
  if (!cssDone) {
    adoptCss(xtermCss);
    cssDone = true;
  }
  const el = document.createElement("div");
  el.className = "term";
  const term = new Terminal({
    theme: THEME,
    fontFamily: 'ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: false,
    macOptionIsMeta: true,
    convertEol: false,
  });
  const fitter = new FitAddon();
  term.loadAddon(fitter);
  let opened = false;
  let frozen = false;
  let cols = 0, rows = 0;
  const decoder = new TextDecoder();

  /* Keystrokes: coalesced per tick, sent strictly in order. */
  let pending = "";
  let chain: Promise<unknown> = Promise.resolve();
  let flushQueued = false;
  const flush = () => {
    flushQueued = false;
    const data = pending;
    pending = "";
    if (!data) return;
    chain = chain.then(() => api.input(sessionId, data)).catch(() => undefined);
  };
  term.onData((d) => {
    if (frozen) return;
    if (Date.now() - sizeAt > 2_000) assertSize();
    pending += d;
    if (!flushQueued) {
      flushQueued = true;
      setTimeout(flush, 8);
    }
  });
  // Alt+1/2/3 answer an approval from the panel; they never reach the agent.
  term.attachCustomKeyEventHandler((ev) => !(ev.altKey && /^Digit[123]$/.test(ev.code)));

  let resizeTimer = 0;
  let sizeAt = 0;
  const sendSize = (force = false) => {
    if (frozen || !opened || !term.cols || !term.rows) return;
    if (!force && term.cols === cols && term.rows === rows) return;
    cols = term.cols;
    rows = term.rows;
    sizeAt = Date.now();
    void api.resize(sessionId, cols, rows).catch(() => undefined);
  };
  /** This view is the one in use: the PTY takes its size, whatever another viewer set. */
  const assertSize = () => sendSize(true);
  el.addEventListener("focusin", assertSize);
  const onVisible = () => {
    if (document.visibilityState === "visible" && el.isConnected) assertSize();
  };
  document.addEventListener("visibilitychange", onVisible);
  const fit = () => {
    if (!el.isConnected || !el.clientWidth || !el.clientHeight) return;
    if (!opened) {
      term.open(el);
      opened = true;
    }
    try {
      fitter.fit();
    } catch {
      /* not laid out yet */
    }
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(sendSize, 60);
  };
  const ro = new ResizeObserver(() => fit());
  ro.observe(el);

  const b64 = (s: string): Uint8Array => {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  const out: Stream = stream(
    termPath(sessionId),
    (event, data) => {
      let msg: { d?: unknown; code?: unknown };
      try {
        msg = JSON.parse(data) as typeof msg;
      } catch {
        return;
      }
      if (event === "data" && typeof msg.d === "string") {
        term.write(decoder.decode(b64(msg.d), { stream: true }));
      } else if (event === "exit") {
        opts.onExit?.(typeof msg.code === "number" ? msg.code : undefined);
      }
    },
    (s, reconnect, err) => {
      // the server replays the scrollback on every connect
      if (s === "open" && reconnect) term.reset();
      if (s === "open") assertSize();
      opts.onState?.(s, err);
    },
  );

  return {
    el,
    focus: () => term.focus(),
    fit,
    freeze(note) {
      if (frozen) return;
      frozen = true;
      term.options.cursorBlink = false;
      term.write(`\r\n\x1b[2m${note}\x1b[0m\r\n`);
    },
    dispose() {
      out.close();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(resizeTimer);
      flush();
      term.dispose();
    },
  };
}
