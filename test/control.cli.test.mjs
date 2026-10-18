// Tests for the control plane's CLI wiring (src/cli.ts, src/control/cli.ts), on a fresh bundle of
// src/cli.ts against a fake HOME and a scratch AGENT_OFFICE_HOME: the banner's Controls line
// (never the unlock link), `agentoffice open --print` and `--rotate`, a watch-only office with
// --no-control, help and doctor rows. No service is installed or loaded.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "agentoffice-ctl-cli-")));
const CLI = join(TMP, "pkg", "dist", "cli.js");
const kids = [];

before(async () => {
  mkdirSync(join(TMP, "pkg", "dist", "web"), { recursive: true });
  await build({
    entryPoints: [join(ROOT, "src/cli.ts")], outfile: CLI, bundle: true, platform: "node", format: "esm", target: "node18",
    external: ["@lydell/node-pty"], logLevel: "error",
  });
  try {
    symlinkSync(join(ROOT, "node_modules"), join(TMP, "pkg", "node_modules"));
  } catch {
    // Terminal support is optional here.
  }
});
after(() => {
  for (const k of kids) if (k.exitCode === null) k.kill("SIGKILL");
  rmSync(TMP, { recursive: true, force: true });
});

let n = 0;
function homes() {
  const home = join(TMP, `home-${n++}`);
  mkdirSync(home, { recursive: true });
  const ao = join(home, ".agentoffice");
  const env = { PATH: process.env.PATH, HOME: home, AGENT_OFFICE_HOME: ao, NO_COLOR: "1", BROWSER: "none", CI: "1", SHELL: "/bin/sh" };
  return { home, ao, env };
}

const run = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 20_000 });

function get(port, path, headers = {}, method = "GET", data) {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, path, headers, agent: false, method }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => done({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end(data);
  });
}

/** Start an office, wait for office.json, return its port and a way to read its output. */
async function office(env, args = []) {
  const child = spawn(process.execPath, [CLI, "--no-open", "--port", "0", "--local-only", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  kids.push(child);
  let output = "";
  child.stdout.on("data", (c) => (output += c));
  child.stderr.on("data", (c) => (output += c));
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const info = JSON.parse(readFileSync(join(env.AGENT_OFFICE_HOME, "office.json"), "utf8"));
      if (info.pid === child.pid && /Ctrl\+C/.test(output)) return { child, info, output: () => output };
    } catch {
      // not yet
    }
  }
  child.kill("SIGKILL");
  throw new Error(`office didn't start: ${output}`);
}

async function stop(child) {
  const exited = new Promise((r) => child.on("exit", r));
  child.kill("SIGTERM");
  await exited;
}

test("help lists open, --no-control and install --service", () => {
  const r = run(["--help"], homes().env);
  assert.equal(r.status, 0);
  for (const w of ["open", "--no-control", "install --service"]) assert.ok(r.stdout.includes(w), w);
  assert.ok(!r.stdout.includes("--service      "), "--service itself stays out of the office flags");
  assert.equal(run(["open", "--bogus"], homes().env).status, 2);
  assert.equal(run(["doctor", "--service"], homes().env).status, 2);
});

test("open with no office running says how to start one", () => {
  const r = run(["open", "--print"], homes().env);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /No office running/);
});

test("a running office: the banner never shows the link; open --print does; the link unlocks once; --rotate logs out", { timeout: 40_000 }, async () => {
  const { env, ao } = homes();
  const { child, info, output } = await office(env);
  try {
    assert.equal(info.control, true);
    assert.match(output(), /Controls\s+locked · agentoffice open unlocks a browser/);
    assert.doesNotMatch(output(), /unlock\?t=/);
    const r = run(["open", "--print"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const link = r.stdout.trim().split("\n")[0];
    assert.match(link, new RegExp(`^http://127\\.0\\.0\\.1:${info.port}/unlock\\?t=[0-9a-z]+\\.[0-9a-f]{12}\\.[0-9a-f]{32}$`));
    assert.match(r.stdout, /once, within 2 minutes/);
    const u = new URL(link);
    const unlocked = await get(info.port, u.pathname + u.search, { "sec-fetch-site": "none" });
    assert.equal(unlocked.status, 303);
    const cookie = unlocked.headers["set-cookie"][0].split(";")[0];
    assert.equal((await get(info.port, u.pathname + u.search)).status, 403, "used once");
    // The page trades the redirect's #unlock handoff for its token; the cookie alone unlocks nothing.
    const handoff = /^\/#unlock=([0-9a-f]{32})$/.exec(unlocked.headers.location)?.[1];
    assert.ok(handoff, unlocked.headers.location);
    const tok = await get(info.port, "/api/control/token", { "x-agent-office": "1", cookie, "content-type": "application/json" }, "POST", JSON.stringify({ handoff }));
    assert.equal(tok.status, 200, tok.body);
    const token = JSON.parse(tok.body).token;
    assert.equal((await get(info.port, "/api/control", { "x-agent-office": "1", cookie })).status, 401, "a cookie without the token");
    const ctl = await get(info.port, "/api/control", { "x-agent-office": "1", "x-agent-office-token": token, cookie });
    assert.equal(ctl.status, 200);
    assert.equal(JSON.parse(ctl.body).enabled, true);
    assert.equal(JSON.parse((await get(info.port, `/api/snapshot?k=${token}`, { cookie })).body).control, "enabled");
    const rot = run(["open", "--rotate", "--print"], env);
    assert.equal(rot.status, 0);
    assert.match(rot.stdout, /logged out/);
    await new Promise((r) => setTimeout(r, 1_100)); // the office re-reads control.json within a second
    assert.equal((await get(info.port, "/api/control", { "x-agent-office": "1", "x-agent-office-token": token, cookie })).status, 401);
    assert.doesNotMatch(output(), /unlock\?t=/, "the office never logs a link");
    assert.ok(!output().includes(token), "nor the token");
    assert.equal(JSON.parse(readFileSync(join(ao, "control.json"), "utf8")).v, 1);
  } finally {
    await stop(child);
  }
});

test("a second office on the same home that quits hands office.json back to the first", { timeout: 40_000 }, async () => {
  const { env, ao } = homes();
  const a = await office(env);
  try {
    const b = await office(env);
    assert.equal(JSON.parse(readFileSync(join(ao, "office.json"), "utf8")).pid, b.child.pid);
    await stop(b.child);
    let pid;
    for (let i = 0; i < 80 && pid !== a.child.pid; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        pid = JSON.parse(readFileSync(join(ao, "office.json"), "utf8")).pid;
      } catch {
        // gone until A writes it again
      }
    }
    assert.equal(pid, a.child.pid, "the office still running advertises itself again");
    const r = run(["open", "--print"], env);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`:${a.info.port}/unlock`));
  } finally {
    await stop(a.child);
  }
});

test("--no-control: watch-only, the snapshot says off and open refuses", { timeout: 30_000 }, async () => {
  const { env } = homes();
  const { child, info, output } = await office(env, ["--no-control"]);
  try {
    assert.equal(info.control, false);
    assert.match(output(), /Controls\s+off \(--no-control\)/);
    assert.equal(JSON.parse((await get(info.port, "/api/snapshot")).body).control, "off");
    assert.equal((await get(info.port, "/api/control", { "x-agent-office": "1" })).status, 404);
    const r = run(["open", "--print"], env);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /controls off/);
  } finally {
    await stop(child);
  }
});

test("doctor shows the control plane's rows (names only for keys)", () => {
  const { env, ao } = homes();
  mkdirSync(ao, { recursive: true });
  const r = run(["doctor"], env);
  for (const w of ["Controls", "Terminals", "Service", "Keys"]) assert.match(r.stdout, new RegExp(`${w}\\s`), w);
  assert.match(r.stdout, /not installed · agentoffice install --service/);
});
