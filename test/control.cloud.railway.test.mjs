// Tests for src/control/cloud/railway.ts (through createPlaces) against a fake Railway GraphQL API,
// a fake exec bridge WebSocket and a fake `railway` CLI. A "sandbox" is a scratch HOME. Covers
// where a new sandbox goes (config.json, or a note naming the key), the create mutation and the
// local record (Railway has no labels), status from that record (a destroyed one is dropped), the
// env file over the bridge (the key in init_exec.env, never in the command), the terminal through
// `railway sandbox ssh` under a local PTY, chat over the bridge with no file at all, the CLI-only
// fallback when the stored login has expired, and delete. Keys are dummies.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, tmp, until, writeBin } from "./remote.fakes.mjs";
import { AGENT_SCRIPT, collect, fakeContext, fakePty, wsServe } from "./control.cloud.fakes.mjs";

const M = await load("src/control/cloud/index.ts");

const KEY = "sk-ant-dummy-railway-0004";
const made = [];
const ptys = [];
const servers = [];
after(async () => {
  for (const p of ptys) p.killAll();
  for (const s of servers) await s.close();
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let n = 0;
async function fakeRailway() {
  const bin = tmp();
  writeBin(bin, "claude", AGENT_SCRIPT);
  made.push(bin);
  const homesFile = join(bin, "homes.json");
  const boxes = [];
  const save = () => writeFileSync(homesFile, JSON.stringify(Object.fromEntries(boxes.map((b) => [b.id, b.home]))));
  const seen = { creates: [], tokens: [], inits: [], destroys: [], queries: [] };
  const srv = await wsServe({
    reject: (req) => (!String(req.headers["sec-websocket-protocol"]).includes("jwt-dummy") ? 401 : 0),
    protocol: (offered) => (offered.includes("railway-shell") ? "railway-shell" : undefined),
    async http(req, body) {
      if (req.headers.authorization !== "Bearer rtok") return { json: { errors: [{ message: "Not Authorized" }] } };
      const q = body?.query ?? "";
      const v = body?.variables ?? {};
      seen.queries.push(q.slice(0, 40));
      if (q.includes("me { workspaces")) return { json: { data: { me: { workspaces: [{ id: "w1" }] } } } };
      if (q.includes("projects(workspaceId")) return { json: { data: { projects: { edges: [{ node: { id: "p1", name: "app", environments: { edges: [{ node: { id: "e1" } }, { node: { id: "e2" } }] } } }], pageInfo: { hasNextPage: false } } } } };
      if (q.includes("sandboxes(environmentId")) return { json: { data: {} } };
      if (q.includes("sandboxCreate")) {
        seen.creates.push(v.input);
        const b = { id: `sbx-${++n}-0000-4000-8000-000000000000`, env: v.input.environmentId, status: "CREATING", home: tmp(), polls: 0 };
        made.push(b.home);
        boxes.push(b);
        save();
        return { json: { data: { sandboxCreate: { id: b.id, status: b.status, environmentId: b.env, createdAt: "2026-10-18T00:00:00.000Z", idleTimeoutMinutes: v.input.idleTimeoutMinutes } } } };
      }
      if (q.includes("sandbox(environmentId")) {
        const b = boxes.find((x) => x.id === v.id && x.env === v.e);
        if (!b) return { json: { data: { sandbox: null } } };
        if (b.status === "CREATING" && ++b.polls >= 1) b.status = "RUNNING";
        return { json: { data: { sandbox: { id: b.id, status: b.status, createdAt: "2026-10-18T00:00:00.000Z" } } } };
      }
      if (q.includes("generateShellToken")) {
        seen.tokens.push(v.input);
        return { json: { data: { generateShellToken: "jwt-dummy" } } };
      }
      if (q.includes("sandboxDestroy")) {
        seen.destroys.push(v);
        const b = boxes.find((x) => x.id === v.id);
        if (b) boxes.splice(boxes.indexOf(b), 1);
        return { json: { data: { sandboxDestroy: { id: v.id, status: "DESTROYING" } } } };
      }
      return { json: { errors: [{ message: `unknown query ${q.slice(0, 30)}` }] } };
    },
    ws(conn) {
      let child;
      conn.onMessage((msg) => {
        if (msg.op === 2) {
          if (msg.data[0] === 2) child?.stdin.write(msg.data.subarray(1));
          return;
        }
        const j = JSON.parse(msg.data);
        if (j.type === "init_exec") {
          seen.inits.push(j.data);
          const b = boxes[boxes.length - 1];
          child = spawn("sh", ["-c", j.data.command], { cwd: b.home, env: { PATH: `${bin}:${process.env.PATH}`, HOME: b.home, ...(j.data.env ?? {}) } });
          child.stdout.on("data", (d) => conn.binary(Buffer.concat([Buffer.from([1]), d])));
          child.stderr.on("data", (d) => conn.binary(Buffer.concat([Buffer.from([3]), d])));
          child.on("exit", (code) => {
            conn.text(JSON.stringify({ type: "exit", data: { exit_code: code ?? 137 } }));
            setTimeout(() => conn.close(1000), 10);
          });
        } else if (j.type === "stdin_close") child?.stdin.end();
        else if (j.type === "signal") child?.kill(`SIG${j.data.signal}`);
      });
    },
  });
  servers.push(srv);
  const cliDir = tmp();
  made.push(cliDir);
  const cli = writeBin(cliDir, "railway", `const fs = require("fs"); const { spawn } = require("child_process");
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(cliDir, "argv.log"))}, JSON.stringify({ a, token: !!process.env.RAILWAY_API_TOKEN }) + "\\n");
if (a[0] !== "sandbox" || (a[1] !== "ssh" && a[1] !== "exec")) process.exit(2);
const id = a[a.indexOf("--id") + 1]; const home = JSON.parse(fs.readFileSync(${JSON.stringify(homesFile)}, "utf8"))[id];
const rest = a.slice(a.indexOf("--") + 1);
// ssh: one word, the remote shell line; exec: an argv.
const argv = a[1] === "ssh" ? ["sh", "-c", rest[0]] : rest;
const c = spawn(argv[0], argv.slice(1), { stdio: "inherit", cwd: home, env: { PATH: ${JSON.stringify(bin)} + ":" + process.env.PATH, HOME: home } });
c.on("exit", (code) => process.exit(code ?? 1));`);
  const cliLog = () => (existsSync(join(cliDir, "argv.log")) ? readFileSync(join(cliDir, "argv.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { srv, seen, boxes, cli, cliLog, save };
}

function places(r, { config = true, token = true, home = tmp() } = {}) {
  made.push(home);
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify({ remotes: [], control: { railway: { project: "p1", environment: "e1" } } }));
  const pty = fakePty();
  ptys.push(pty);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    AGENT_OFFICE_HOME: home,
    RAILWAY_GRAPHQL_ENDPOINT: `${r.srv.url}/graphql`,
    RAILWAY_TCP_PROXY_WS_ENDPOINT: `${r.srv.wsUrl}/ws/exec`,
    ...(token ? { RAILWAY_API_TOKEN: "rtok" } : {}),
  };
  const ctx = fakeContext({ home, pty, env });
  return { ctx, pty, home, places: M.createPlaces(ctx, { pollMs: 10, bins: { railway: r.cli } }) };
}

test("no environment to put a sandbox in: canCreate is false and the note names the config key", async () => {
  const r = await fakeRailway();
  const { places: p } = places(r, { config: false });
  const row = (await p.status()).find((x) => x.kind === "railway");
  assert.equal(row.ready, true);
  assert.equal(row.canCreate, false, "two environments on the account: no guessing");
  assert.match(row.note, /"control": \{"railway": \{"project": "<id>", "environment": "<id>"\}\}/);
  await assert.rejects(p.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} }), (e) => e.status === 409);
});

test("create, record, open a terminal through the railway CLI: the key went over the bridge's env, not the command", async () => {
  const r = await fakeRailway();
  const { places: p, pty, home } = places(r);
  const place = await p.open({ kind: "railway", target: "new" }, { agent: "claude", sandbox: { timeoutMin: 500 }, progress: () => {} });
  assert.deepEqual(r.seen.creates[0], { environmentId: "e1", idleTimeoutMinutes: 120, networkIsolation: "ISOLATED" });
  const id = r.boxes[0].id;
  assert.equal(place.host.id, `railway:${id}`);
  assert.equal(place.ours, true);
  const reg = JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8")).sandboxes;
  assert.deepEqual(reg.map((x) => [x.provider, x.id, x.environmentId, x.projectId]), [["railway", id, "e1", "p1"]]);
  assert.match(reg[0].name, /^agentoffice-/);

  await place.ensureAgent("claude", () => {});
  const term = await place.attach({ argv: ["claude", { env: "AO_PROMPT" }], cwd: place.cwd, env: { ANTHROPIC_API_KEY: KEY, AO_PROMPT: "go" }, secret: ["ANTHROPIC_API_KEY"] }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  const hello = JSON.parse(out.text().split("\n")[0]);
  assert.equal(hello.keys.ANTHROPIC_API_KEY, KEY);
  assert.deepEqual(hello.argv, ["go"]);
  assert.deepEqual(hello.files.filter((f) => f.endsWith(".env")), []);
  term.write("quit\n");
  assert.equal((await out.done).code, 3);

  const spawn0 = pty.spawns[0];
  assert.equal(spawn0.file, r.cli);
  assert.deepEqual(spawn0.args.slice(0, 8), ["sandbox", "ssh", "--id", id, "-p", "p1", "-e", "e1"]);
  assert.equal(spawn0.args[8], "--");
  assert.match(spawn0.args[9], /^sh -c ' /);
  assert.ok(!JSON.stringify(spawn0.args).includes(KEY) && !JSON.stringify(spawn0.args).includes('"go"'));
  const envInit = r.seen.inits.find((i) => i.env?.AO_ENV);
  assert.ok(envInit.env.AO_ENV.includes(KEY), "the env file came from that command's own env");
  assert.ok(r.seen.inits.every((i) => !i.command.includes(KEY)), "never in a bridge command");
  assert.ok(r.seen.inits.every((i) => i.ephemeral === true), "ephemeral: no durable session keeps the output");
  assert.deepEqual(r.seen.tokens[0], { environmentId: "e1", instanceId: id, kind: "sandbox", scope: "shell" });
  assert.equal(r.srv.requests.find((x) => x.method === "UPGRADE").headers["sec-websocket-protocol"], "railway-shell, jwt-dummy");

  const row = (await p.status({ fresh: true })).find((x) => x.kind === "railway");
  assert.equal(row.canCreate, true);
  assert.deepEqual(row.sandboxes.map((s) => [s.id, s.ours, s.status]), [[id, true, "running"]]);
});

test("chat over the bridge: the keys are the command's env (no file), stdin and stdout frames, exit", async () => {
  const r = await fakeRailway();
  const { places: p } = places(r);
  const place = await p.open({ kind: "railway", target: "new" }, { agent: "codex", progress: () => {} });
  writeBin(join(r.boxes[0].home, "bin"), "codex", AGENT_SCRIPT);
  const pipe = await place.pipe({ argv: ["codex", "app-server"], cwd: place.cwd, env: { OPENAI_API_KEY: "sk-dummy-openai-rw" }, secret: ["OPENAI_API_KEY"], path: ["~/bin"] });
  const chunks = [];
  pipe.onStdout((c) => chunks.push(Buffer.from(c).toString()));
  await until(() => chunks.join("").includes("\n"), 5000, "first line");
  const hello = JSON.parse(chunks.join("").split("\n")[0]);
  assert.equal(hello.keys.OPENAI_API_KEY, "sk-dummy-openai-rw");
  assert.deepEqual(hello.argv.slice(0, 2), ["-c", "model_provider=agentoffice"]);
  assert.deepEqual(hello.files, [], "no env file at all");
  pipe.write("ping\n");
  await until(() => chunks.join("").includes("got:ping"), 5000, "echo");
  const exited = new Promise((res) => pipe.onExit(res));
  pipe.end();
  assert.equal((await exited).code, 0);
  const init = r.seen.inits[r.seen.inits.length - 1];
  assert.equal(init.env.OPENAI_API_KEY, "sk-dummy-openai-rw");
  assert.ok(!init.command.includes("sk-dummy-openai-rw"));
});

test("with only the CLI (the stored login expired), the env file goes over `railway sandbox ssh` stdin", async () => {
  const r = await fakeRailway();
  const first = places(r);
  const place0 = await first.places.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} });
  const id = place0.host.id.slice("railway:".length);
  // Same office home (the record), no API token, an expired CLI login.
  const home = first.home;
  mkdirSync(join(home, ".railway"), { recursive: true });
  writeFileSync(join(home, ".railway/config.json"), JSON.stringify({ user: { accessToken: "old", tokenExpiresAt: 1 } }));
  const second = places(r, { token: false, home });
  const row = (await second.places.status()).find((x) => x.kind === "railway");
  assert.equal(row.ready, true);
  assert.equal(row.via, "railway CLI");
  const place = await second.places.open({ kind: "railway", target: id }, { agent: "claude", progress: () => {} });
  assert.equal(place.ours, true, "from the record");
  const term = await place.attach({ argv: ["claude"], cwd: place.cwd, env: { ANTHROPIC_API_KEY: KEY }, secret: ["ANTHROPIC_API_KEY"] }, { cols: 80, rows: 24 });
  const out = collect(term);
  await until(() => out.text().includes("\n"), 5000, "agent output");
  assert.equal(JSON.parse(out.text().split("\n")[0]).keys.ANTHROPIC_API_KEY, KEY);
  const calls = r.cliLog();
  assert.ok(calls.every((c) => !JSON.stringify(c.a).includes(KEY)), "no key on the CLI's argv");
  assert.match(calls.find((c) => c.a.at(-1).includes("cat >")).a.at(-1), /^sh -c 'umask 077;/);
  term.write("quit\n");
  await out.done;
  assert.deepEqual(readdirSync(join(r.boxes[0].home, ".agentoffice/run")).filter((f) => f.endsWith(".env")), []);
});

test("status drops a recorded sandbox Railway no longer has; delete destroys only the office's own", async () => {
  const r = await fakeRailway();
  const { places: p, home } = places(r);
  const a = await p.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} });
  const b = await p.open({ kind: "railway", target: "new" }, { agent: "claude", progress: () => {} });
  r.boxes.splice(0, 1); // a was destroyed by its idle timeout
  const row = (await p.status({ fresh: true })).find((x) => x.kind === "railway");
  assert.deepEqual(row.sandboxes.map((s) => s.id), [b.host.id.slice(8)]);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "sandboxes.json"), "utf8")).sandboxes.map((s) => s.id), [b.host.id.slice(8)]);
  await p.deleteSandbox("railway", b.host.id.slice(8));
  assert.deepEqual(r.seen.destroys, [{ id: b.host.id.slice(8), e: "e1" }]);
  await assert.rejects(p.deleteSandbox("railway", "someone-elses"), (e) => e.status === 409);
  assert.ok(a);
});
