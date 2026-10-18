// Tests for the web app's DOM-free parts: busy-pod seating (web/scene/layout.ts),
// the intern summary chip text, OfficeEvent.replaces in the chrome's model
// (web/ui/state.ts) and the control store's session lookup (web/ui/control/store.ts).
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agentoffice-web-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
    loader: { ".svg": "text", ".css": "text" },
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { Layout, SEAT_W, MAX_BENCH, MAX_HOT, POD_H, internSummary, OfficeModel, ControlStore } = await load(
  "web/scene/layout.ts",
  "web/scene/util.ts",
  "web/ui/state.ts",
  "web/ui/control/store.ts",
);

/** A pod with one main worker and `n` interns, packed and settled. */
function crew(n, mains = 1) {
  const layout = new Layout();
  const seats = [];
  for (let m = 0; m < mains; m++) {
    layout.allocMain(`main${m}`, "claude", "Codes", undefined, 0);
    for (let i = 0; i < n; i++) seats.push(layout.allocIntern(`m${m}-sub${i}`, `main${m}`, "claude", "Codes", undefined, 0));
  }
  for (let t = 0; t < 200; t++) layout.update(16, t * 16);
  return { layout, seats, block: [...layout.blocks.values()][0] };
}

test("a busy pod seats every intern: nobody stands", () => {
  for (const n of [5, 9, 15]) {
    const { seats } = crew(n);
    assert.equal(seats.length, n);
    for (const s of seats) assert.equal(s.kind, "intern", `${n} interns: ${s.kind}`);
  }
});

test("1 + 9: the main desk's bench fills, the overflow goes to a hot desk, all on the rug", () => {
  const { seats, block } = crew(9);
  const own = seats.filter((s) => !s.st.hot), hot = seats.filter((s) => s.st.hot);
  assert.equal(own.length, MAX_BENCH);
  assert.equal(hot.length, 9 - MAX_BENCH);
  assert.equal(block.stations.at(-1).hot, true, "hot desks sit at the end of the pod");
  const xs = seats.map((s) => s.x).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= SEAT_W, `seats ${xs[i - 1]} and ${xs[i]} overlap`);
  for (const s of seats) {
    assert.ok(s.x - 7 >= block.x && s.x + 7 <= block.x + block.w, `intern at ${s.x} is off the rug [${block.x}, ${block.x + block.w}]`);
    assert.ok(s.y < block.y + POD_H, "inside the pod");
  }
});

test("two crowded desks share hot desks, and a hot desk never becomes a main desk", () => {
  const { layout, seats, block } = crew(MAX_BENCH + 5, 2);
  assert.equal(seats.filter((s) => s.st.hot).length, 10);
  assert.ok(block.stations.filter((s) => s.hot).every((s) => s.seats <= MAX_HOT));
  layout.allocMain("main2", "claude", "Codes", undefined, 0);
  const st = layout.seatOf("main2").st;
  assert.ok(!st.hot, "a new session gets a real desk");
  assert.ok(block.stations.indexOf(st) < block.stations.findIndex((s) => s.hot), "desks before hot desks");
});

test("an empty hot desk is cleared away after a short linger", () => {
  const { layout, block } = crew(MAX_BENCH + 2);
  let now = 10_000;
  for (let i = MAX_BENCH; i < MAX_BENCH + 2; i++) layout.free(`m0-sub${i}`, now);
  for (let t = 0; t < 200; t++) layout.update(16, (now += 16));
  assert.ok(block.stations.some((s) => s.hot), "still lingering");
  for (let t = 0; t < 200; t++) layout.update(16, (now += 16));
  assert.ok(!block.stations.some((s) => s.hot), "gone once it lingered");
});

test("rename keeps the seat: a replacing worker takes over the desk in place", () => {
  const layout = new Layout();
  const seat = layout.allocMain("ctl:ab12", "claude", "api", undefined, 0);
  layout.rename("ctl:ab12", "sess-1");
  assert.equal(layout.seatOf("sess-1"), seat);
  assert.equal(layout.seatOf("ctl:ab12"), undefined);
  assert.equal(seat.st.main, "sess-1");
});

test("intern summary: counts roles, folds the rest into +N when it doesn't fit", () => {
  const roles = ["fork", "fork", "general-purpose", "fork", "fork"];
  assert.equal(internSummary(roles, 60), "5 interns · fork ×4 · general-purpose");
  assert.equal(internSummary(roles, 24), "5 interns · fork ×4 · +1");
  assert.equal(internSummary(roles, 10), "5 interns · +2");
  assert.equal(internSummary(["Explore", "Plan", "Explore"], 60), "3 interns · Explore ×2 · Plan");
});

test("OfficeEvent.replaces moves a worker, its history and its interns to the new id", () => {
  const m = new OfficeModel();
  m.load({ version: 1, startedAt: "", demo: false, workers: [], recent: [] });
  const base = { ts: new Date().toISOString(), agent: "claude", project: "api" };
  m.apply({ ...base, seq: 1, workerId: "ctl:ab12", kind: "session_start" });
  m.apply({ ...base, seq: 2, workerId: "ctl:ab12", kind: "tool_start", tool: "Read", category: "read", summary: "Read a.ts" });
  m.apply({ ...base, seq: 3, workerId: "sub1", parentId: "ctl:ab12", kind: "subagent_start", role: "Explore" });
  const ch = m.apply({ ...base, seq: 4, workerId: "sess-1", kind: "session_start", replaces: "ctl:ab12" });
  assert.deepEqual(ch.renamed, { from: "ctl:ab12", to: "sess-1" });
  assert.equal(ch.joined, undefined, "no new worker joins");
  assert.equal(m.get("ctl:ab12"), undefined);
  const w = m.get("sess-1");
  assert.equal(w.toolCalls, 1);
  assert.ok(w.history.some((a) => a.summary === "Read a.ts"));
  assert.equal(m.get("sub1").parentId, "sess-1");
  assert.equal(m.workers.size, 2);
});

test("control store: sessions arrive by event and are found by their (renamed) worker", () => {
  const store = new ControlStore();
  store.state = "enabled";
  store.info = { enabled: true, agents: [], providers: [], keys: [], service: { supported: false, installed: false, running: false, startAtLogin: false, platform: "x" }, sessions: [], recentFolders: [] };
  const seen = [];
  store.subscribe((what) => seen.push(what));
  const s = { id: "ab12", agent: "claude", place: { kind: "local", target: "/w/api" }, mode: "terminal", workerId: "ctl:ab12", status: "starting", startedAt: new Date().toISOString(), title: "api", permission: "default" };
  store.onEvent("control", s);
  assert.equal(store.forWorker("ctl:ab12")?.id, "ab12");
  store.onEvent("control", { ...s, workerId: "sess-1", status: "running" });
  assert.equal(store.forWorker("ctl:ab12"), undefined);
  assert.equal(store.forWorker("sess-1")?.status, "running");
  store.onEvent("control_info", { keys: [{ name: "K", agents: [], preview: "k…1", addedAt: "" }] });
  assert.equal(store.info.keys.length, 1);
  store.onEvent("control_gone", { id: "ab12" });
  assert.equal(store.sessions.size, 0);
  assert.ok(seen.includes("sessions") && seen.includes("info"));
});

test("control store: a locked or control-less snapshot needs no request", async () => {
  const store = new ControlStore();
  let fetched = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; return new Response("{}", { status: 401 }); };
  try {
    await store.fromSnapshot("locked");
    assert.equal(store.state, "locked");
    await store.fromSnapshot("off");
    assert.equal(store.state, "off");
    assert.equal(fetched, 0);
    await store.fromSnapshot(undefined);
    assert.equal(fetched, 1, "absent: probe once");
    assert.equal(store.state, "locked", "a 401 probe locks");
  } finally {
    globalThis.fetch = realFetch;
  }
});
