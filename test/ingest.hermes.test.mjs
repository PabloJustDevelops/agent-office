// Hermes through the whole loop (src/ingest/index.ts + hermes.ts): a synthetic
// state.db in WAL mode, backfilled, then live rows (a prompt, a tool call and
// its result, a reply, a child session as an intern) and a terminal run that
// ends in "Exit code: 1". Skipped on Nodes without node:sqlite.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agentoffice-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const I = await load("src/ingest/index.ts", "src/shared/events.ts", "src/server/state.ts");
let sqlite;
try {
  sqlite = await import("node:sqlite");
} catch {
  sqlite = null;
}

const kinds = (evs) => evs.map((e) => e.kind);
const sec = () => Date.now() / 1000;
const tc = (id, name, args) => [{ id, call_id: id, response_item_id: `r_${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];

function makeDb(dir) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "state.db");
  const db = new sqlite.DatabaseSync(path);
  db.exec(`pragma journal_mode = wal;
    create table sessions (
      id text primary key, source text, profile_name text, model text, billing_provider text,
      cwd text, git_repo_root text, git_branch text,
      started_at real, last_activity_at real not null, ended_at real,
      message_count integer default 0, tool_call_count integer default 0, tool_names text,
      input_tokens integer default 0, output_tokens integer default 0,
      cache_read_tokens integer default 0, cache_write_tokens integer default 0, reasoning_tokens integer default 0,
      parent_session_id text, title text, archived integer default 0, hidden integer default 0, pinned integer default 0
    );
    create table messages (
      id integer primary key, session_id text not null, role text, tool_name text, tool_call_id text,
      tool_calls text, timestamp real not null, content text
    );
    create index messages_session_time_id_idx on messages (session_id, timestamp, id);`);
  const api = {
    path,
    session(id, o = {}) {
      const t = sec();
      db.prepare(`insert or replace into sessions
        (id, source, profile_name, model, cwd, started_at, last_activity_at, parent_session_id, title)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, o.source ?? "local", o.profile ?? "default", o.model ?? "deepseek/deepseek-v4.1-flash",
          o.cwd ?? "/tmp/demo-app", t, t, o.parent ?? null, o.title ?? null);
    },
    touch(id) {
      db.prepare("update sessions set last_activity_at = ? where id = ?").run(sec(), id);
    },
    message(id, sid, o = {}) {
      db.prepare(`insert or replace into messages (id, session_id, role, tool_name, tool_call_id, tool_calls, timestamp, content)
        values (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, sid, o.role ?? null, o.tool_name ?? null, o.tool_call_id ?? null,
          o.tool_calls ? JSON.stringify(o.tool_calls) : null, o.ts ?? sec(), o.content ?? "");
      api.touch(sid);
    },
    close: () => db.close(),
  };
  return api;
}

/** A session that already ran the suite: prompt, terminal call, result, reply. */
function seed(db) {
  db.session("ses_main");
  db.message(1, "ses_main", { role: "user", content: "please run the tests and read auth.ts" });
  db.message(2, "ses_main", { role: "assistant", tool_calls: tc("c1", "terminal", { command: "npm test" }) });
  db.message(3, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "c1", content: "Tests: 0 failed\nExit code: 0" });
  db.message(4, "ses_main", { role: "assistant", content: "Done." });
}

async function scenario(t) {
  if (!sqlite) {
    t.skip("node:sqlite not available");
    return null;
  }
  const dir = mkdtempSync(join(tmpdir(), "agentoffice-hm-"));
  const db = makeDb(join(dir, "hermes"));
  seed(db);
  const events = [];
  const all = [];
  const ingest = I.createIngest({
    agents: ["hermes"],
    onEvent: (e) => events.push(e),
    watch: false,
    env: { AGENT_OFFICE_HERMES_DIR: join(dir, "hermes"), AGENT_OFFICE_HOME: join(dir, "ao") },
  });
  const tick = async () => {
    await ingest.tick();
    const evs = events.splice(0);
    all.push(...evs);
    return evs;
  };
  try {
    const back = await tick();
    return { db, tick, back, dir, ingest, all };
  } catch (err) {
    db.close();
    throw err;
  }
}

function cleanup(s) {
  s.ingest.stop();
  s.db.close();
  rmSync(s.dir, { recursive: true, force: true });
}

test("hermes: backfill poses the session, live rows animate it", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    assert.deepEqual(kinds(s.back), ["session_start", "waiting"]);
    assert.equal(s.back[0].project, "demo-app");
    assert.equal(s.back[0].model, "deepseek/deepseek-v4.1-flash");

    s.db.message(5, "ses_main", { role: "user", content: "SECRET_PROMPT_TEXT" });
    assert.deepEqual(kinds(await s.tick()), ["prompt"]);

    s.db.message(6, "ses_main", { role: "assistant", tool_calls: tc("c2", "read_file", { file_path: "/tmp/demo-app/src/auth.ts" }) });
    let evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_start"]);
    assert.equal(evs[0].summary, "Read auth.ts");
    assert.equal(evs[0].category, "read");

    s.db.message(7, "ses_main", { role: "tool", tool_name: "read_file", tool_call_id: "c2", content: "FILE_BODY_SECRET" });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_end"]);
    assert.equal(evs[0].summary, "Read auth.ts");

    s.db.message(8, "ses_main", { role: "assistant", content: "Replied with words." });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["reply", "waiting"]);
    assert.deepEqual(await s.tick(), []);

    const wire = JSON.stringify(s.all);
    assert.ok(!wire.includes("SECRET_PROMPT_TEXT"), "prompt text never reaches an event");
    assert.ok(!wire.includes("FILE_BODY_SECRET"), "file content never reaches an event");
    assert.ok(!wire.includes("please run the tests"), "old prompt text never reaches an event");
  } finally {
    cleanup(s);
  }
});

// Cutting the serialized tool_calls column at 2,000 characters loses every call after a big one, and a
// terminal call whose arguments got cut has no command, so its test verdict is never scored.
test("hermes: a big argument doesn't swallow the calls after it", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    const big = "x".repeat(9000);
    s.db.message(5, "ses_main", {
      role: "assistant",
      tool_calls: [
        ...tc("p1", "patch", { path: "/tmp/demo-app/src/big.ts", patch: big }),
        ...tc("p2", "terminal", { command: "npm test" }),
      ],
    });
    const evs = (await s.tick()).filter((e) => e.kind === "tool_start");
    assert.equal(evs.length, 2, "both calls in one row are reported");
    assert.equal(evs[0].summary, "Edit big.ts");
    assert.equal(evs[1].summary, "$ npm test");
  } finally {
    cleanup(s);
  }
});

// A live poll must read everything written since the last row it saw. Reading "the last N messages"
// drops the assistant row that issued a call when a burst of writes lands between two polls, and the
// result then has nothing to close — a failed test included.
test("hermes: a burst of writes between polls still closes its call", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: tc("b1", "terminal", { command: "npm test" }) });
    s.db.message(6, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "b1", content: "1 test failed\nExit code: 1" });
    for (let i = 7; i <= 16; i++) s.db.message(i, "ses_main", { role: "user", content: `filler ${i}` });
    const evs = await s.tick();
    assert.ok(kinds(evs).includes("tool_start"), "the call that the burst pushed out of the window still starts");
    assert.ok(kinds(evs).includes("test_fail"), "and its failure is still scored");
  } finally {
    cleanup(s);
  }
});

// The driver can be perfect and still reach nobody: OfficeState.sanitize drops an event whose agent it
// doesn't know. Fold the ingest output through the office itself, or a new agent can look green in the
// parser and be invisible on screen.
test("hermes: the office keeps the worker the ingest hands it", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    const office = new I.OfficeState({ home: null, now: () => Date.now() });
    for (const e of s.all) office.ingest(e);
    const snap = office.snapshot();
    assert.equal(snap.workers.length, 1);
    assert.equal(snap.workers[0].agent, "hermes");
    assert.equal(snap.workers[0].project, "demo-app");
    assert.ok(snap.recent.some((e) => e.agent === "hermes" && e.kind === "session_start"));
  } finally {
    cleanup(s);
  }
});

test("hermes: a child session walks in as an intern", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.session("ses_kid", { parent: "ses_main", profile: "reviewer" });
    s.db.message(20, "ses_kid", { role: "assistant", tool_calls: tc("k1c", "terminal", { command: "npm test" }) });
    const kid = (await s.tick()).filter((e) => e.workerId === "ses_kid");
    assert.deepEqual(kinds(kid), ["subagent_start", "tool_start"]);
    assert.equal(kid[0].parentId, "ses_main");
    assert.equal(kid[0].role, "reviewer");
    assert.equal(kid[1].summary, "$ npm test");
  } finally {
    cleanup(s);
  }
});

test("hermes: a terminal run ending in Exit code: 1 flips the table", async (t) => {
  const s = await scenario(t);
  if (!s) return;
  try {
    s.db.message(5, "ses_main", { role: "assistant", tool_calls: tc("c9", "terminal", { command: "npm test" }) });
    let evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_start"]);
    assert.equal(evs[0].summary, "$ npm test");

    s.db.message(6, "ses_main", { role: "tool", tool_name: "terminal", tool_call_id: "c9", content: "1 test failed\nExit code: 1" });
    evs = await s.tick();
    assert.deepEqual(kinds(evs), ["tool_end", "test_fail"]);
    assert.equal(evs[1].isError, true);
  } finally {
    cleanup(s);
  }
});
