/*
 * Railway Sandboxes as places: GraphQL with the login the watcher uses
 * (src/remote/railway.ts), its exec bridge over a WebSocket, and the
 * `railway` CLI for the terminal.
 *
 *   where    a new sandbox needs a project environment: a RAILWAY_TOKEN project token's,
 *            else {"control": {"railway": {"project", "environment"}}} in
 *            ~/.agentoffice/config.json, else the `railway link` of the office's folder,
 *            else the account's only environment
 *   create   sandboxCreate {environmentId, idleTimeoutMinutes (1..120), networkIsolation:
 *            ISOLATED}; destroyed by Railway once idle that long. Railway sandboxes have no
 *            names or labels, so every one the office makes is recorded in sandboxes.json
 *   ours     the recorded ids, one sandbox(environmentId, id) query each
 *   delete   sandboxDestroy(id, environmentId)
 *   exec     the watcher's budgeted target (sandboxExec) for polls; installs and env files
 *            go over the exec bridge, wss://ssh.railway.com:2226/ws/exec (subprotocols
 *            railway-shell + a 5-minute generateShellToken), which streams and has no
 *            one-minute cap: init_exec {command, env, ephemeral}, binary frames tagged
 *            0x01 stdout / 0x02 stdin / 0x03 stderr, {type: "exit", data: {exit_code}}
 *   TTY      railway sandbox ssh --id -p -e -- "sh -c '<line>'" under a local PTY: the CLI
 *            registers its ssh key on the account if it has to (its own behaviour) and
 *            heartbeats while connected
 *   chat     the exec bridge with the keys in init_exec.env (no file at all); without an API
 *            token, `railway sandbox ssh` on plain pipes with the env file
 *
 * Keys: create-time `variables` are baked into the sandbox for its lifetime, so they never
 * carry one. The TTY's env file is written by an ephemeral bridge exec whose own env holds
 * the values (no stdin, nothing in the command), or, with only the CLI, by `railway sandbox
 * ssh` reading the lines on stdin (UNVERIFIED that it forwards stdin). Railway's relay keeps
 * about 8 MiB of a terminal's scrollback for its durable sessions.
 */
import { join } from "node:path";
import type { ProviderStatus, SandboxInfo } from "../../shared/control.ts";
import { configPath } from "../../remote/config.ts";
import { RAILWAY_GQL, RailwayBudget, createRailwayProvider, railwayToken } from "../../remote/railway.ts";
import { RemoteError, displayName, homeOf, http, jsonOf, readJson, run, str, which } from "../../remote/util.ts";
import { ControlError, type Launch, type OpenOptions, type PipeProc, type PlacesContext, type Term, type TermExit } from "../types.ts";
import { connectWs } from "../ws.ts";
import { tgzOf, type TarEntry } from "../tar.ts";
import { cleanupScript, cwdScript, envFromStdinScript, envFromVarScript, envLines, launchLine, parseCwd, shWrap } from "./launch.ts";
import {
  BasePlace, Listeners, Once, afterExit, failed, helperEnv, sandboxRow, sid as newSid, sleep, spawnPipe, untarScript,
  type Cloud, type CloudDeps, type CreateOptions,
} from "./place.ts";

export const RAILWAY_EXEC_WS = "wss://ssh.railway.com:2226/ws/exec";
const API_TIMEOUT_MS = 20_000;
const START_WAIT_MS = 2 * 60_000;
const ENV_TTL_MS = 5 * 60_000;
const NO_CLI = "Install the railway CLI to open terminals in Railway sandboxes";

type Token = { token: string; project: boolean; via: string };

export interface RailwayBox {
  id: string;
  environmentId: string;
  projectId: string;
  name: string;
}

function stateOf(s: string | undefined): SandboxInfo["status"] {
  if (s === "RUNNING") return "running";
  if (s === "CREATING") return "starting";
  if (s === "DESTROYED" || s === "DESTROYING" || s === "FAILED") return "stopped";
  return "unknown";
}

export function railwayCloud(d: CloudDeps): Cloud {
  const ctx = d.ctx;
  const env = () => ctx.providerEnv();
  const budget = d.railwayBudget ?? new RailwayBudget(ctx.now);
  const pollMs = d.pollMs ?? 3_000;
  const cli = () => d.bins?.railway ?? which("railway", env());
  let envCache: { at: number; key: string; where?: { projectId: string; environmentId: string; how: string } } | undefined;
  /** id -> where, from the last auto listing. */
  const seen = new Map<string, RailwayBox>();

  const gqlOf = (t: Token) => async (query: string, variables: Record<string, unknown>): Promise<any> => {
    const headers: Record<string, string> = t.project ? { "project-access-token": t.token } : { authorization: `Bearer ${t.token}` };
    budget.take();
    const r = await http(str(env().RAILWAY_GRAPHQL_ENDPOINT) ?? RAILWAY_GQL, { method: "POST", headers, body: { query, variables }, timeoutMs: API_TIMEOUT_MS, fetch: d.fetch });
    budget.observe(r);
    const j = jsonOf(r, "Railway API");
    if (Array.isArray(j?.errors) && j.errors.length) {
      const msg = String(j.errors[0]?.message ?? "error");
      throw new RemoteError(/not authorized|unauthorized|authentication|invalid token|forbidden/i.test(msg) ? "auth" : /not found/i.test(msg) ? "gone" : "failed", `Railway: ${msg}`);
    }
    return j?.data ?? {};
  };

  const token = (): Token | undefined => {
    const t = railwayToken({ env: env() });
    return "why" in t ? undefined : t;
  };

  /** The project environment a new sandbox goes in, and how it was found. */
  async function where(t: Token): Promise<{ projectId: string; environmentId: string; how: string } | undefined> {
    const key = `${t.via}:${t.project}`;
    if (envCache && envCache.key === key && ctx.now() - envCache.at < ENV_TTL_MS) return envCache.where;
    const gql = gqlOf(t);
    let w: { projectId: string; environmentId: string; how: string } | undefined;
    if (t.project) {
      const p = (await gql("query { projectToken { projectId environmentId } }", {})).projectToken;
      if (str(p?.projectId) && str(p?.environmentId)) w = { projectId: p.projectId, environmentId: p.environmentId, how: "RAILWAY_TOKEN" };
    }
    const cfg = readJson(configPath(env()))?.control?.railway;
    if (!w && str(cfg?.project) && str(cfg?.environment)) w = { projectId: cfg.project, environmentId: cfg.environment, how: "config.json" };
    if (!w) {
      const linked = readJson(join(homeOf(env()), ".railway", "config.json"))?.projects;
      const cwd = process.cwd();
      let best = "";
      for (const [dir, p] of Object.entries<any>(linked && typeof linked === "object" ? linked : {})) {
        const dd = dir.replace(/\/+$/, "");
        if ((cwd === dd || cwd.startsWith(dd + "/")) && dd.length > best.length && str(p?.project) && str(p?.environment)) best = dd;
      }
      if (best) w = { projectId: linked[best].project, environmentId: linked[best].environment, how: "railway link" };
    }
    if (!w && !t.project) {
      const all: { projectId: string; environmentId: string }[] = [];
      const me = await gql("query { me { workspaces { id } } }", {});
      for (const ws of me.me?.workspaces ?? []) {
        const p = await gql("query($w: String!) { projects(workspaceId: $w, first: 50) { edges { node { id environments { edges { node { id } } } } } } }", { w: ws.id });
        for (const { node } of p.projects?.edges ?? []) for (const { node: e } of node.environments?.edges ?? []) all.push({ projectId: node.id, environmentId: e.id });
        if (all.length > 1) break;
      }
      if (all.length === 1) w = { ...all[0]!, how: "your only environment" };
    }
    envCache = { at: ctx.now(), key, where: w };
    return w;
  }

  const NEED_ENV = `Railway needs a project environment for new sandboxes: set "control": {"railway": {"project": "<id>", "environment": "<id>"}} in ${configPath(env()).replace(homeOf(env()), "~")}`;

  async function ready(t: Token | undefined, box: RailwayBox, asked: string | undefined, ours: boolean, o: OpenOptions): Promise<RailwayPlace> {
    const probe = new RailwayPlace(ctx, d, budget, t, box, "/", ours, o.agent);
    const cwd = parseCwd(await probe.run(cwdScript(asked, ours || !!o.createCwd), { timeoutMs: 60_000 }), asked, `Railway ${box.name}`);
    return new RailwayPlace(ctx, d, budget, t, box, cwd, ours, o.agent);
  }

  return {
    kind: "railway",
    name: "Railway",
    login() {
      const t = railwayToken({ env: env() });
      if (!("why" in t)) return { ready: true, via: t.via };
      if (cli() && (t as { expired?: boolean }).expired) return { ready: true, via: "railway CLI" };
      return { ready: false, why: t.why };
    },

    async status(): Promise<ProviderStatus> {
      const row: ProviderStatus = { kind: "railway", name: "Railway", ready: false, canCreate: false, sandboxes: [] };
      const lg = this.login();
      if (!lg.ready) return { ...row, note: lg.why };
      const t = token();
      const out: ProviderStatus = { ...row, ready: true, via: lg.via };
      const rows = new Map<string, SandboxInfo>();
      for (const r of d.registry.list("railway")) {
        rows.set(r.id, sandboxRow(ctx, "railway", { id: r.id, name: r.name, status: "unknown", ours: true, createdAt: r.createdAt }, `railway:${r.id}`));
      }
      if (!t) {
        out.note = "Railway's stored login has expired: run any railway command to refresh it";
        return { ...out, sandboxes: [...rows.values()] };
      }
      const gql = gqlOf(t);
      try {
        for (const r of d.registry.list("railway")) {
          if (!r.environmentId) continue;
          let s: any;
          try {
            s = (await gql("query($e: String!, $id: String!) { sandbox(environmentId: $e, id: $id) { id status createdAt } }", { e: r.environmentId, id: r.id })).sandbox;
          } catch (err) {
            if ((err as RemoteError).code !== "gone") throw err;
          }
          if (!s || s.status === "DESTROYED") {
            d.registry.remove("railway", r.id);
            rows.delete(r.id);
            continue;
          }
          rows.set(r.id, sandboxRow(ctx, "railway", { id: r.id, name: r.name, status: stateOf(s.status), ours: true, createdAt: str(s.createdAt) ?? r.createdAt }, `railway:${r.id}`));
        }
        const p = createRailwayProvider({ env: env(), fetch: d.fetch, budget, timeoutMs: API_TIMEOUT_MS });
        for (const x of await p.list("auto")) {
          const id = x.host.id.slice("railway:".length);
          if (x.meta?.projectId && x.meta.environmentId) seen.set(id, { id, projectId: x.meta.projectId, environmentId: x.meta.environmentId, name: x.host.name });
          if (rows.has(id)) continue;
          rows.set(id, sandboxRow(ctx, "railway", { id, name: x.host.name, status: "running", ours: false }, x.host.id));
        }
      } catch (err) {
        const code = (err as RemoteError).code;
        if (code === "auth") return { ...out, ready: false, note: (err as Error).message };
        // "throttled" or a hiccup: show what we have.
      }
      let w;
      try {
        w = await where(t);
      } catch {
        w = undefined;
      }
      if (!cli()) return { ...out, note: NO_CLI, sandboxes: [...rows.values()] };
      if (!w) return { ...out, note: NEED_ENV, sandboxes: [...rows.values()] };
      return { ...out, canCreate: true, sandboxes: [...rows.values()] };
    },

    async create(c: CreateOptions, o: OpenOptions): Promise<BasePlace> {
      const t = token();
      if (!t) throw new ControlError(502, "Railway: creating a sandbox needs an API token (RAILWAY_API_TOKEN) or a fresh railway login");
      if (!cli()) throw new ControlError(503, NO_CLI);
      const w = await where(t);
      if (!w) throw new ControlError(409, NEED_ENV);
      const gql = gqlOf(t);
      o.progress("creating", "Creating Railway sandbox…");
      const idle = Math.min(120, Math.max(1, c.timeoutMin));
      const made = (await gql(
        "mutation($input: SandboxCreateInput!) { sandboxCreate(input: $input) { id status environmentId createdAt idleTimeoutMinutes } }",
        { input: { environmentId: w.environmentId, idleTimeoutMinutes: idle, networkIsolation: "ISOLATED" } },
      )).sandboxCreate;
      const id = str(made?.id);
      if (!id) throw new ControlError(502, "Railway: create answered without a sandbox id");
      const box: RailwayBox = { id, environmentId: w.environmentId, projectId: w.projectId, name: c.name };
      d.registry.add({ provider: "railway", ...box, createdAt: str(made.createdAt) ?? new Date(ctx.now()).toISOString() });
      c.onCreated?.(id);
      let status = made.status;
      const t0 = Date.now();
      while (status !== "RUNNING") {
        if (status === "FAILED" || status === "DESTROYED") throw new ControlError(502, `Railway sandbox didn't start (${status})`);
        if (Date.now() - t0 > START_WAIT_MS) throw new ControlError(502, "Railway sandbox didn't start within 2 minutes");
        await sleep(pollMs, o.signal);
        status = (await gql("query($e: String!, $id: String!) { sandbox(environmentId: $e, id: $id) { id status } }", { e: w.environmentId, id })).sandbox?.status;
      }
      return ready(t, box, c.cwd, true, o);
    },

    async open(id: string, cwd: string | undefined, o: OpenOptions): Promise<BasePlace> {
      const rec = d.registry.get("railway", id);
      let box: RailwayBox | undefined = rec?.environmentId && rec.projectId ? { id, environmentId: rec.environmentId, projectId: rec.projectId, name: rec.name } : seen.get(id);
      if (!box) {
        await this.status().catch(() => {});
        box = seen.get(id);
      }
      if (!box) throw new ControlError(404, "No such Railway sandbox in your linked project or the office's own");
      return ready(token(), box, cwd, !!rec, o);
    },

    async remove(id: string): Promise<void> {
      const t = token();
      const rec = d.registry.get("railway", id);
      const e = rec?.environmentId ?? seen.get(id)?.environmentId;
      if (!t) throw new ControlError(502, "Railway: deleting a sandbox needs an API token or a fresh railway login");
      if (!e) throw new ControlError(404, "No such Railway sandbox");
      try {
        await gqlOf(t)("mutation($id: String!, $e: String!) { sandboxDestroy(id: $id, environmentId: $e) { id status } }", { id, e });
      } catch (err) {
        if ((err as RemoteError).code !== "gone") throw err;
      }
      d.registry.remove("railway", id);
      seen.delete(id);
    },
  };
}

interface BridgeRun {
  command: string;
  env?: Record<string, string>;
  stdin?: string | Buffer;
  timeoutMs: number;
}

export class RailwayPlace extends BasePlace {
  constructor(
    private readonly ctx: PlacesContext,
    private readonly deps: CloudDeps,
    private readonly budget: RailwayBudget,
    private readonly tok: Token | undefined,
    private readonly box: RailwayBox,
    cwd: string,
    ours: boolean,
    agent: OpenOptions["agent"],
  ) {
    const target = createRailwayProvider({ env: ctx.providerEnv(), fetch: deps.fetch, budget, bin: deps.bins?.railway }).targetFor(box);
    super({ host: { kind: "railway", id: `railway:${box.id}`, name: displayName(box.name) }, cwd, ours, target, agent, where: `Railway ${displayName(box.name)}`, log: ctx.log });
  }

  private cli(): string | undefined {
    return this.deps.bins?.railway ?? which("railway", this.ctx.providerEnv());
  }

  private sshArgs(remote: string): string[] {
    return ["sandbox", "ssh", "--id", this.box.id, "-p", this.box.projectId, "-e", this.box.environmentId, "--", remote];
  }

  /** A short-lived token for the exec bridge (one API call from the shared budget). */
  private async shellToken(): Promise<string> {
    const t = this.tok!;
    const headers: Record<string, string> = t.project ? { "project-access-token": t.token } : { authorization: `Bearer ${t.token}` };
    this.budget.take();
    const r = await http(str(this.ctx.providerEnv().RAILWAY_GRAPHQL_ENDPOINT) ?? RAILWAY_GQL, {
      method: "POST",
      headers,
      body: {
        query: "mutation($input: ShellTokenInput!) { generateShellToken(input: $input) }",
        variables: { input: { environmentId: this.box.environmentId, instanceId: this.box.id, kind: "sandbox", scope: "shell" } },
      },
      timeoutMs: API_TIMEOUT_MS,
      fetch: this.deps.fetch,
    });
    this.budget.observe(r);
    const j = jsonOf(r, "Railway API");
    const jwt = str(j?.data?.generateShellToken);
    if (!jwt) throw new RemoteError(/authori/i.test(String(j?.errors?.[0]?.message)) ? "auth" : "failed", `Railway ${this.box.name}: no shell token`);
    return jwt;
  }

  private endpoint(): string {
    return (str(this.ctx.providerEnv().RAILWAY_TCP_PROXY_WS_ENDPOINT) ?? RAILWAY_EXEC_WS).replace(/\/+$/, "");
  }

  /** One command over the exec bridge: ephemeral (no durable session keeps its output). */
  private async bridgeOpen(command: string, env: Record<string, string> | undefined) {
    const jwt = await this.shellToken();
    const ws = await connectWs(this.endpoint(), { protocols: ["railway-shell", jwt], timeoutMs: 15_000 });
    ws.send(JSON.stringify({ type: "init_exec", data: { command, ephemeral: true, ...(env && Object.keys(env).length ? { env } : {}) } }));
    return ws;
  }

  private async bridge(o: BridgeRun): Promise<{ code: number; stdout: string; stderr: string }> {
    const ws = await this.bridgeOpen(o.command, o.env);
    return new Promise((resolve, reject) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let size = 0;
      const t = setTimeout(() => {
        ws.send(JSON.stringify({ type: "signal", data: { signal: "TERM" } }));
        ws.close();
        reject(new RemoteError("timeout", `Railway ${this.box.name}: timed out`));
      }, o.timeoutMs);
      t.unref?.();
      ws.onMessage((m) => {
        if (typeof m === "string") {
          let j: any;
          try {
            j = JSON.parse(m);
          } catch {
            return;
          }
          if (j?.type === "exit") {
            clearTimeout(t);
            ws.close();
            resolve({ code: typeof j.data?.exit_code === "number" ? j.data.exit_code : -1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
          } else if (j?.type === "error") {
            clearTimeout(t);
            ws.close();
            reject(new RemoteError("failed", `Railway ${this.box.name}: exec bridge error (${String(j.data?.code ?? "unknown").slice(0, 40)})`));
          }
          return;
        }
        if (m.byteLength < 2) return;
        const body = Buffer.from(m.subarray(1));
        size += body.length;
        if (size > 32 << 20) return;
        if (m[0] === 1) out.push(body);
        else if (m[0] === 3 && err.length < 64) err.push(body);
      });
      ws.onClose((code) => {
        clearTimeout(t);
        reject(new RemoteError("unreachable", `Railway ${this.box.name}: exec bridge closed (${code})`));
      });
      if (o.stdin !== undefined) {
        const b = typeof o.stdin === "string" ? Buffer.from(o.stdin, "utf8") : o.stdin;
        for (let i = 0; i < b.length; i += 16 << 10) ws.send(Buffer.concat([Buffer.from([2]), b.subarray(i, i + (16 << 10))]));
      }
      ws.send(JSON.stringify({ type: "stdin_close" }));
    });
  }

  async run(script: string, o: { timeoutMs: number }): Promise<string> {
    if (!this.tok) return this.target.exec(script, o);
    const r = await this.bridge({ command: shWrap(script), timeoutMs: o.timeoutMs });
    if (r.code !== 0) throw failed(`Railway ${this.box.name}`, r.code, r.stderr || r.stdout);
    return r.stdout;
  }

  /** The values are this bridge command's env (no file, no stdin); with only the CLI, assignments on its stdin. */
  protected async runSecret(script: string, env: Record<string, string>, o: { timeoutMs: number }): Promise<string> {
    if (this.tok) {
      const r = await this.bridge({ command: shWrap(script), env, timeoutMs: o.timeoutMs });
      if (r.code !== 0) throw failed(`Railway ${this.box.name}`, r.code, r.stderr || r.stdout);
      return r.stdout;
    }
    const bin = this.cli();
    if (!bin) throw new ControlError(503, NO_CLI);
    const r = await run(bin, this.sshArgs("sh -s"), { input: `${envLines(env)}${script}\n`, timeoutMs: o.timeoutMs, env: helperEnv(this.ctx.providerEnv(), true) });
    if (r.code !== 0) throw failed(`Railway ${this.box.name}`, r.code ?? "?", r.stderr);
    return r.stdout;
  }

  /** The archive on the exec bridge's stdin into `tar xzf -` (Railway has no file upload). */
  protected async upload(entries: TarEntry[], dir: string, o: { home: string; timeoutMs: number }): Promise<void> {
    if (!this.tok) throw new ControlError(502, "Railway: copying files needs an API token (RAILWAY_API_TOKEN) or a fresh railway login");
    const tgz = await tgzOf(entries);
    const r = await this.bridge({ command: shWrap(untarScript(dir)), stdin: tgz, timeoutMs: o.timeoutMs });
    if (r.code !== 0) throw failed(`Railway ${this.box.name}`, r.code, r.stderr || r.stdout);
  }

  /** The env file: from this command's own env over the bridge, or the CLI's stdin. */
  private async envFile(launch: Launch, id: string): Promise<boolean> {
    if (!Object.keys(launch.env).length) return false;
    const lines = envLines(launch.env);
    if (this.tok) {
      const r = await this.bridge({ command: shWrap(envFromVarScript(id)), env: { AO_ENV: lines }, timeoutMs: 60_000 });
      if (r.code !== 0) throw failed(`Railway ${this.box.name}`, r.code, r.stderr);
      return true;
    }
    const bin = this.cli();
    if (!bin) throw new ControlError(503, NO_CLI);
    const r = await run(bin, this.sshArgs(shWrap(envFromStdinScript(id))), { input: lines, timeoutMs: 60_000, env: helperEnv(this.ctx.providerEnv(), true) });
    if (r.code !== 0) throw failed(`Railway ${this.box.name}`, r.code ?? "?", r.stderr);
    return true;
  }

  private cleanup(id: string): void {
    this.run(cleanupScript(id), { timeoutMs: 30_000 }).catch(() => {});
  }

  protected async openTerm(launch: Launch, size: { cols: number; rows: number }, id: string, path: string[] | undefined): Promise<Term> {
    const bin = this.cli();
    if (!bin) throw new ControlError(503, NO_CLI);
    const pty = await this.ctx.pty();
    if (!pty) throw new ControlError(503, "Terminal mode needs the PTY library on this machine");
    const withFile = await this.envFile(launch, id);
    const line = launchLine(launch, { sid: id, envFile: withFile, path });
    let term: Term;
    try {
      term = pty.spawn({ file: bin, args: this.sshArgs(shWrap(line)), cwd: this.ctx.userHome, env: helperEnv(this.ctx.providerEnv(), true), cols: size.cols, rows: size.rows });
    } catch (err) {
      if (withFile) this.cleanup(id);
      throw err;
    }
    return withFile ? afterExit(term, () => this.cleanup(id)) : term;
  }

  async pipe(launch: Launch): Promise<PipeProc> {
    const l = this.prepare(launch);
    const id = newSid();
    const path = l.path?.length ? l.path : this.path;
    if (!this.tok) {
      const bin = this.cli();
      if (!bin) throw new ControlError(503, NO_CLI);
      const withFile = await this.envFile(l, id);
      const p = spawnPipe(bin, this.sshArgs(shWrap(launchLine(l, { sid: id, envFile: withFile, path }))), helperEnv(this.ctx.providerEnv(), true), this.ctx.userHome);
      if (withFile) p.onExit(() => this.cleanup(id));
      return p;
    }
    // The keys are this one command's environment: no file at all.
    const ws = await this.bridgeOpen(shWrap(launchLine(l, { sid: id, path })), l.env);
    const out = new Listeners<Uint8Array>();
    const err = new Listeners<Uint8Array>();
    const exit = new Once<TermExit>();
    ws.onMessage((m) => {
      if (typeof m === "string") {
        try {
          const j = JSON.parse(m);
          if (j?.type === "exit") {
            exit.fire({ code: typeof j.data?.exit_code === "number" ? j.data.exit_code : null });
            ws.close();
          }
        } catch {
          // Not a control frame.
        }
        return;
      }
      if (m.byteLength < 2) return;
      if (m[0] === 1) out.emit(m.subarray(1));
      else if (m[0] === 3) err.emit(m.subarray(1));
    });
    ws.onClose(() => exit.fire({ code: null }));
    const signalName = (s?: NodeJS.Signals) => (s ?? "SIGTERM").replace(/^SIG/, "");
    return {
      write(d) {
        const b = typeof d === "string" ? Buffer.from(d, "utf8") : Buffer.from(d);
        for (let i = 0; i < b.length; i += 16 << 10) ws.send(Buffer.concat([Buffer.from([2]), b.subarray(i, i + (16 << 10))]));
      },
      end: () => ws.send(JSON.stringify({ type: "stdin_close" })),
      onStdout: (fn) => out.on(fn),
      onStderr: (fn) => err.on(fn),
      onExit: (fn) => exit.on(fn),
      kill(signal) {
        if (exit.fired) return;
        ws.send(JSON.stringify({ type: "signal", data: { signal: signalName(signal) } }));
        if (signal === "SIGKILL") ws.close();
      },
    };
  }
}
