// Tests for src/control/term.ts: the headless screen answers a TUI's terminal queries itself,
// drops a browser's duplicate answer, replays the screen (modes included) to late viewers with
// no gap or duplicate, coalesces frames under 64 KB, and ends viewers with the exit code.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cleanup, load, ROOT, sleep, until } from "./control.session-fakes.mjs";

const { TermBuffer, replyKinds, FRAME_MAX, REPLY_DEDUP_MS } = await load("src/control/term.ts");
after(cleanup);
const { Terminal } = createRequire(ROOT + "/x.js")("@xterm/headless");

function viewer() {
  const chunks = [];
  let exit;
  return {
    sink: { data: (c) => chunks.push(Buffer.from(c)), exit: (code) => (exit = { code }) },
    chunks,
    text: () => Buffer.concat(chunks).toString("utf8"),
    exit: () => exit,
  };
}

/** What a browser's xterm would show after these bytes. */
async function render(bytes, cols = 80, rows = 24) {
  const t = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  await new Promise((r) => t.write(bytes, r));
  const b = t.buffer.active;
  const lines = [];
  for (let y = 0; y < rows; y++) lines.push((b.getLine(b.viewportY + y)?.translateToString(true) ?? "").trimEnd());
  return { text: lines.join("\n").trimEnd(), modes: t.modes, alt: b.type === "alternate" };
}

test("answers DSR, DA1 and DA2 into the PTY, and drops the browser's copy for a while", async () => {
  let now = 1_000;
  const replies = [];
  const tb = new TermBuffer({ cols: 80, rows: 24, reply: (d) => replies.push(d), now: () => now });
  tb.write(Buffer.from("hi\x1b[6n\x1b[c\x1b[>c"));
  await until(() => replies.length >= 3, 2000, "replies");
  assert.deepEqual(replies.flatMap(replyKinds).sort(), ["cpr", "da1", "da2"]);
  assert.equal(tb.filterInput("\x1b[1;3R"), "", "the browser's CPR is a duplicate");
  assert.equal(tb.filterInput("a\x1b[?1;2cb"), "ab", "DA1 taken out, keys kept");
  assert.equal(tb.filterInput("\x1b]11;rgb:0000/0000/0000\x1b\\"), "\x1b]11;rgb:0000/0000/0000\x1b\\", "OSC 11 isn't answered server-side, so it passes");
  assert.equal(tb.filterInput("\x1b[A"), "\x1b[A", "arrow keys untouched");
  now += REPLY_DEDUP_MS + 1;
  assert.equal(tb.filterInput("\x1b[1;3R"), "\x1b[1;3R", "later on, a CPR is the browser's own");
  tb.dispose();
});

test("replay: a late viewer sees the screen, modes and alt buffer, then live bytes, no gap or duplicate", async () => {
  const tb = new TermBuffer({ cols: 80, rows: 24, reply: () => {} });
  tb.write(Buffer.from("line one\r\nline two\r\n"));
  tb.write(Buffer.from("\x1b[?2004h\x1b[?1h\x1b[?1049h\x1b[HALT SCREEN"));
  const v = viewer();
  tb.attach(v.sink);
  // Bytes arriving while the replay is prepared must come after it, exactly once.
  tb.write(Buffer.from(" +live"));
  await until(() => v.text().includes("+live"), 2000, "live bytes");
  assert.equal(v.text().split("+live").length, 2, "no duplicate");
  const shown = await render(v.text());
  assert.equal(shown.alt, true, "alt buffer restored");
  assert.ok(shown.text.startsWith("ALT SCREEN +live"), shown.text);
  assert.equal(shown.modes.bracketedPasteMode, true);
  assert.equal(shown.modes.applicationCursorKeysMode, true);
  assert.equal(tb.bracketedPaste, true);
  tb.dispose();
});

test("two viewers, one attached early and one late, end up with the same screen", async () => {
  const tb = new TermBuffer({ cols: 60, rows: 10, reply: () => {} });
  const early = viewer();
  tb.attach(early.sink);
  for (let i = 0; i < 40; i++) tb.write(Buffer.from(`row ${i} ${"x".repeat(i % 7)}\r\n`));
  const late = viewer();
  tb.attach(late.sink);
  for (let i = 40; i < 60; i++) tb.write(Buffer.from(`row ${i}\r\n`));
  await sleep(80);
  const a = await render(early.text(), 60, 10);
  const b = await render(late.text(), 60, 10);
  assert.equal(b.text, a.text);
  assert.match(a.text, /row 59/);
  tb.dispose();
});

test("frames are coalesced and capped at 64 KB", async () => {
  const tb = new TermBuffer({ cols: 80, rows: 24, reply: () => {} });
  const v = viewer();
  tb.attach(v.sink);
  await sleep(30);
  const before = v.chunks.length;
  for (let i = 0; i < 100; i++) tb.write(Buffer.alloc(2048, 0x61));
  await until(() => v.chunks.slice(before).reduce((n, c) => n + c.length, 0) >= 204_800, 3000, "all bytes");
  const frames = v.chunks.slice(before);
  assert.ok(frames.length <= 6, `${frames.length} frames for 100 writes`);
  for (const f of frames) assert.ok(f.length <= FRAME_MAX);
  tb.dispose();
});

test("exit: live viewers get the rest then exit; a viewer after exit gets the replay then exit", async () => {
  const tb = new TermBuffer({ cols: 80, rows: 24, reply: () => {} });
  const v1 = viewer();
  tb.attach(v1.sink);
  tb.write(Buffer.from("bye\r\n"));
  await sleep(30);
  tb.exit(3);
  assert.deepEqual(v1.exit(), { code: 3 });
  assert.match(v1.text(), /bye/);
  const v2 = viewer();
  tb.attach(v2.sink);
  await until(() => v2.exit(), 2000, "exit after replay");
  assert.match(v2.text(), /bye/);
  assert.deepEqual(v2.exit(), { code: 3 });
  assert.equal(tb.viewerCount, 0);
  tb.dispose();
  const v3 = viewer();
  tb.attach(v3.sink);
  assert.deepEqual(v3.exit(), { code: 3 });
});

test("resize clamps and a viewer that throws is dropped", async () => {
  const tb = new TermBuffer({ cols: 80, rows: 24, reply: () => {} });
  tb.resize(5, 1000);
  assert.equal(tb.cols, 10);
  assert.equal(tb.rows, 200);
  tb.attach({ data: () => { throw new Error("gone"); }, exit: () => {} });
  tb.write(Buffer.from("x"));
  await sleep(40);
  assert.equal(tb.viewerCount, 0);
  tb.dispose();
});
