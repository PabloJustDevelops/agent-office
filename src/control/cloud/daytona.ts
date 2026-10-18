/*
 * Daytona sandboxes as places, over the same HTTP API and login the watcher
 * uses (src/remote/daytona.ts), plus the toolbox's PTY.
 *
 *   create  POST {api}/sandbox {name: "agentoffice-…", labels: {agentoffice: "1"},
 *           autoStopInterval: 15, autoDeleteInterval: 0, ttlMinutes}: deleted as soon as
 *           it stops, and never alive past its TTL; then GET /sandbox/{id} until started
 *   ours    what sandboxes.json records: the label is for finding them
 *           (GET {api}/sandbox?labels={"agentoffice":"1"}), and anyone in the
 *           organization can set it, a teammate's own office included
 *   delete  DELETE {api}/sandbox/{id}
 *   alive   POST {api}/sandbox/{id}/last-activity every 5 min while a session runs
 *           (whether PTY traffic counts as activity is UNVERIFIED, so heartbeat anyway)
 *   exec    POST {toolbox}/{id}/process/execute {command, envs, timeout}
 *   TTY     POST {toolbox}/{id}/process/pty {id, cwd, envs: {TERM}, cols, rows}, then the
 *           WebSocket …/process/pty/{session}/connect (subprotocol X-Daytona-Pty-Exit-Control),
 *           resize with POST …/resize, DELETE …/pty/{session} when done. The PTY is the
 *           user's login shell, so the launch line is typed into it once it says "connected".
 *           Fallback: `daytona ssh <id>` under a local PTY, with the same typed line.
 *
 * Keys: PTY `envs` are kept by the daemon and echoed by GET, and the sandbox's own `env`
 * is stored by Daytona, so neither carries a key. They go into a 0600 env file written by
 * one /process/execute whose per-command `envs` holds them, and the typed line sources and
 * deletes that file before the agent starts. No chat mode here in v1.
 */
import type { ProviderStatus, SandboxInfo } from "../../shared/control.ts";
import type { RemoteTarget } from "../../shared/events.ts";
import { shQuote } from "../../remote/source.ts";
import { createDaytonaProvider, daytonaLogin, daytonaToolboxUrl, type DaytonaLogin } from "../../remote/daytona.ts";
import { RemoteError, displayName, http, jsonOf, scrubMessage, str, which } from "../../remote/util.ts";
import { ControlError, type Launch, type OpenOptions, type PlacesContext, type Term } from "../types.ts";
import { connectWs, type Ws } from "../ws.ts";
import { cleanupScript, cwdScript, envFromVarScript, envLines, launchLine, parseCwd, shWrap } from "./launch.ts";
import {
  BasePlace, StreamTerm, afterExit, failed, helperEnv, sandboxRow, sleep,
  type Cloud, type CloudDeps, type CreateOptions,
} from "./place.ts";

export const EXIT_CONTROL = "X-Daytona-Pty-Exit-Control";
const API_TIMEOUT_MS = 20_000;
const START_WAIT_MS = 2 * 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const CONNECT_WAIT_MS = 15_000;

interface Box {
  id: string;
  name: string;
  proxy: string;
}

function stateOf(s: string | undefined): SandboxInfo["status"] {
  if (s === "started") return "running";
  if (s === "creating" || s === "starting" || s === "restoring" || s === "pulling_snapshot" || s === "resuming") return "starting";
  if (s === "stopped" || s === "stopping" || s === "archived" || s === "archiving" || s === "paused" || s === "pausing") return "stopped";
  return "unknown";
}

export function daytonaCloud(d: CloudDeps): Cloud {
  const ctx = d.ctx;
  const env = () => ctx.providerEnv();
  const pollMs = d.pollMs ?? 2_000;

  const login = (): DaytonaLogin => {
    const l = daytonaLogin({ env: env() });
    if ("why" in l) throw new ControlError(502, `Daytona: ${l.why}`);
    return l;
  };
  const api = async (l: DaytonaLogin, path: string, o: { method?: string; body?: unknown; what: string; timeoutMs?: number }) =>
    jsonOf(await http(l.api + path, { method: o.method, headers: l.headers, body: o.body, timeoutMs: o.timeoutMs ?? API_TIMEOUT_MS, fetch: d.fetch }), o.what);

  async function listOurs(l: DaytonaLogin): Promise<any[]> {
    const out: any[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ labels: JSON.stringify({ agentoffice: "1" }), limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const j = await api(l, `/sandbox?${q}`, { what: "Daytona sandboxes" });
      out.push(...(Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : []));
      cursor = Array.isArray(j) ? undefined : str(j?.nextCursor);
      if (!cursor) break;
    }
    return out;
  }

  function place(l: DaytonaLogin, box: Box, cwd: string, ours: boolean, o: OpenOptions): DaytonaPlace {
    return new DaytonaPlace(ctx, d, l, box, cwd, ours, o.agent);
  }

  async function ready(l: DaytonaLogin, s: any, asked: string | undefined, ours: boolean, o: OpenOptions): Promise<DaytonaPlace> {
    const id = String(s.id);
    const box: Box = { id, name: displayName(str(s.name) ?? id.slice(0, 8)), proxy: str(s.toolboxProxyUrl)?.replace(/\/+$/, "") ?? (await daytonaToolboxUrl(l, id, { timeoutMs: API_TIMEOUT_MS, fetch: d.fetch })) };
    const probe = place(l, box, "/", ours, o);
    const cwd = parseCwd(await probe.run(cwdScript(asked, ours), { timeoutMs: 30_000 }), asked, `Daytona ${box.name}`);
    return place(l, box, cwd, ours, o);
  }

  return {
    kind: "daytona",
    name: "Daytona",
    login() {
      const l = daytonaLogin({ env: env() });
      return "why" in l ? { ready: false, why: l.why } : { ready: true, via: l.via };
    },

    async status(): Promise<ProviderStatus> {
      const base: ProviderStatus = { kind: "daytona", name: "Daytona", ready: false, canCreate: false, sandboxes: [] };
      const l = daytonaLogin({ env: env() });
      if ("why" in l) return { ...base, note: l.why };
      const rows = new Map<string, SandboxInfo>();
      const recorded = d.registry.list("daytona");
      let listed = false;
      try {
        for (const s of await listOurs(l)) {
          const id = str(s?.id);
          if (!id) continue;
          const ours = !!d.registry.get("daytona", id);
          // Labelled by another office (a teammate's): like any sandbox someone else made, shown only while it runs.
          if (!ours && stateOf(s.state) !== "running") continue;
          rows.set(id, sandboxRow(ctx, "daytona", {
            id, name: displayName(str(s.name) ?? id.slice(0, 8)), status: stateOf(s.state), ours,
            ...(str(s.createdAt) ? { createdAt: s.createdAt } : {}), ...(str(s.autoDestroyAt) ? { expiresAt: s.autoDestroyAt } : {}),
          }, `daytona:${id}`));
        }
        listed = true;
      } catch (err) {
        if ((err as RemoteError).code === "auth") return { ...base, via: l.via, note: (err as Error).message };
      }
      // A recorded sandbox the labelled listing no longer has was deleted (they go when they stop).
      // (Not one made in the last two minutes: a listing may lag behind the create.)
      if (listed) for (const r of recorded) if (!rows.has(r.id) && ctx.now() - Date.parse(r.createdAt) > 2 * 60_000) d.registry.remove("daytona", r.id);
      try {
        for (const x of await createDaytonaProvider({ env: env(), fetch: d.fetch, timeoutMs: API_TIMEOUT_MS }).list("auto")) {
          const id = x.host.id.slice("daytona:".length);
          if (rows.has(id)) continue;
          rows.set(id, sandboxRow(ctx, "daytona", { id, name: x.host.name, status: "running", ours: !!d.registry.get("daytona", id) }, x.host.id));
        }
      } catch {
        // A shared organization isn't auto-watched; its sandboxes can still be named by id.
      }
      return { ...base, ready: true, via: l.via, canCreate: true, sandboxes: [...rows.values()] };
    },

    async create(c: CreateOptions, o: OpenOptions): Promise<BasePlace> {
      const l = login();
      o.progress("creating", "Creating Daytona sandbox…");
      const body: Record<string, unknown> = {
        name: c.name,
        labels: { agentoffice: "1" },
        autoStopInterval: 15,
        autoDeleteInterval: 0,
        ttlMinutes: c.timeoutMin,
        ...(l.target ? { target: l.target } : {}),
      };
      const made = await api(l, "/sandbox", { method: "POST", body, what: "Daytona create" });
      const id = str(made?.id);
      if (!id) throw new ControlError(502, "Daytona: create answered without a sandbox id");
      d.registry.add({ provider: "daytona", id, name: str(made.name) ?? c.name, createdAt: str(made.createdAt) ?? new Date(ctx.now()).toISOString() });
      c.onCreated?.(id);
      let s = made;
      const t0 = Date.now();
      while (s?.state !== "started") {
        if (s?.state === "error" || s?.state === "build_failed" || s?.state === "destroyed") {
          await api(l, `/sandbox/${encodeURIComponent(id)}`, { method: "DELETE", what: "Daytona delete" }).catch(() => {});
          throw new ControlError(502, `Daytona sandbox didn't start (${s.state}${str(s.errorReason) ? `: ${String(s.errorReason).slice(0, 120)}` : ""})`);
        }
        if (Date.now() - t0 > START_WAIT_MS) throw new ControlError(502, "Daytona sandbox didn't start within 2 minutes");
        await sleep(pollMs, o.signal);
        s = await api(l, `/sandbox/${encodeURIComponent(id)}`, { what: "Daytona sandbox" });
      }
      o.progress("starting", "Daytona sandbox is up…");
      return ready(l, s, c.cwd, true, o);
    },

    async open(id: string, cwd: string | undefined, o: OpenOptions): Promise<BasePlace> {
      const l = login();
      let s: any;
      try {
        s = await api(l, `/sandbox/${encodeURIComponent(id)}`, { what: "Daytona sandbox" });
      } catch (err) {
        if ((err as RemoteError).code === "gone") throw new ControlError(404, "No such Daytona sandbox");
        throw err;
      }
      if (s?.state !== "started") throw new ControlError(409, `Daytona sandbox ${displayName(str(s?.name) ?? id)} is ${str(s?.state) ?? "not running"}; start it first`);
      // The label alone doesn't make it ours: first-run seeding only goes into sandboxes this office made.
      const ours = !!d.registry.get("daytona", String(s.id));
      return ready(l, s, cwd, ours, o);
    },

    async remove(id: string): Promise<void> {
      const l = login();
      try {
        await api(l, `/sandbox/${encodeURIComponent(id)}`, { method: "DELETE", what: "Daytona delete" });
      } catch (err) {
        if ((err as RemoteError).code !== "gone") throw err;
      }
      d.registry.remove("daytona", id);
    },
  };
}

export class DaytonaPlace extends BasePlace {
  private readonly hdrs: Record<string, string>;

  constructor(
    private readonly ctx: PlacesContext,
    private readonly deps: CloudDeps,
    private readonly l: DaytonaLogin,
    private readonly box: Box,
    cwd: string,
    ours: boolean,
    agent: OpenOptions["agent"],
  ) {
    const target: RemoteTarget = {
      host: { kind: "daytona", id: `daytona:${box.id}`, name: box.name },
      // What the watcher polls: stderr dropped, like src/remote/daytona.ts.
      exec: (script, eo) => this.exec(`sh -c ${shQuote(script)} 2>/dev/null`, eo?.timeoutMs ?? 20_000),
    };
    super({ host: target.host, cwd, ours, target, agent, where: `Daytona ${box.name}`, log: ctx.log });
    this.hdrs = l.headers;
  }

  private toolbox(path: string): string {
    return `${this.box.proxy}/${encodeURIComponent(this.box.id)}${path}`;
  }

  /** One /process/execute; output is stdout and stderr merged. `envs` is per command and never echoed. */
  private async exec(command: string, timeoutMs: number, envs?: Record<string, string>): Promise<string> {
    const r = await http(this.toolbox("/process/execute"), {
      method: "POST",
      headers: this.hdrs,
      body: { command, timeout: Math.max(1, Math.ceil(timeoutMs / 1000)), ...(envs ? { envs } : {}) },
      timeoutMs: timeoutMs + 5_000,
      fetch: this.deps.fetch,
    });
    const j = jsonOf(r, `Daytona ${this.box.name}`);
    const code = j?.exitCode ?? j?.code ?? 0;
    const out = typeof j?.result === "string" ? j.result : "";
    if (code !== 0) throw failed(`Daytona ${this.box.name}`, code, out);
    return out;
  }

  run(script: string, o: { timeoutMs: number }): Promise<string> {
    return this.exec(`sh -c ${shQuote(script)} 2>&1`, o.timeoutMs);
  }

  private cleanup(id: string): void {
    this.exec(`sh -c ${shQuote(cleanupScript(id))}`, 15_000).catch(() => {});
  }

  protected async openTerm(launch: Launch, size: { cols: number; rows: number }, id: string, path: string[] | undefined): Promise<Term> {
    const withFile = Object.keys(launch.env).length > 0;
    if (withFile) await this.exec(shWrap(envFromVarScript(id)), 30_000, { AO_ENV: envLines(launch.env) });
    const typed = ` exec ${shWrap(launchLine(launch, { sid: id, envFile: withFile, path, typed: true }))}\r`;
    try {
      const term = await this.ptyTerm(id, size, typed);
      return withFile ? afterExit(term, () => this.cleanup(id)) : term;
    } catch (err) {
      const code = (err as RemoteError).code;
      const cli = this.deps.bins?.daytona ?? which("daytona", this.ctx.providerEnv());
      const pty = code !== "auth" && cli ? await this.ctx.pty() : null;
      if (!pty || !cli) {
        if (withFile) this.cleanup(id);
        throw err;
      }
      this.log(`Daytona ${this.box.name}: the toolbox terminal failed (${scrubMessage((err as Error).message)}); using \`daytona ssh\``, "warn");
      const term = pty.spawn({ file: cli, args: ["ssh", this.box.id], cwd: this.ctx.userHome, env: helperEnv(this.ctx.providerEnv(), true), cols: size.cols, rows: size.rows });
      // The login shell reads it once it's up; the PTY holds it until then.
      term.write(typed);
      return withFile ? afterExit(term, () => this.cleanup(id)) : term;
    }
  }

  /** The toolbox PTY over its WebSocket. */
  private async ptyTerm(id: string, size: { cols: number; rows: number }, typed: string): Promise<Term> {
    const created = jsonOf(
      await http(this.toolbox("/process/pty"), {
        method: "POST",
        headers: this.hdrs,
        body: { id: `ao-${id}`, cwd: this.cwd, envs: { TERM: "xterm-256color" }, cols: size.cols, rows: size.rows },
        timeoutMs: API_TIMEOUT_MS,
        fetch: this.deps.fetch,
      }),
      `Daytona ${this.box.name} terminal`,
    );
    const session = str(created?.sessionId) ?? `ao-${id}`;
    const ptyPath = `/process/pty/${encodeURIComponent(session)}`;
    const drop = () => {
      http(this.toolbox(ptyPath), { method: "DELETE", headers: this.hdrs, timeoutMs: API_TIMEOUT_MS, fetch: this.deps.fetch }).catch(() => {});
    };
    let ws: Ws;
    try {
      ws = await connectWs(this.toolbox(`${ptyPath}/connect`).replace(/^http/, "ws"), {
        headers: this.hdrs,
        protocols: [EXIT_CONTROL],
        timeoutMs: CONNECT_WAIT_MS,
      });
    } catch (err) {
      drop();
      throw err;
    }
    const term = new StreamTerm({
      write: (b) => ws.send(b),
      resize: (cols, rows) => {
        http(this.toolbox(`${ptyPath}/resize`), { method: "POST", headers: this.hdrs, body: { cols, rows }, timeoutMs: API_TIMEOUT_MS, fetch: this.deps.fetch }).catch(() => {});
      },
      kill: () => {
        // Deleting the session kills the shell (and the agent it exec'd); the close frame reports it.
        drop();
        setTimeout(() => {
          if (!term.ended) {
            ws.close();
            term.end({ code: null });
          }
        }, 5_000).unref?.();
      },
    });
    let connected = false;
    const ok = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new RemoteError("timeout", `Daytona ${this.box.name}: the terminal didn't connect`)), CONNECT_WAIT_MS);
      t.unref?.();
      ws.onMessage((m) => {
        if (typeof m !== "string") return term.push(m);
        let j: any;
        try {
          j = JSON.parse(m);
        } catch {
          return term.push(Buffer.from(m, "utf8"));
        }
        if (j?.type !== "control") return term.push(Buffer.from(m, "utf8"));
        if (j.status === "connected" && !connected) {
          connected = true;
          clearTimeout(t);
          resolve();
        } else if (j.status === "exited") {
          if (term.end({ code: typeof j.exitCode === "number" ? j.exitCode : null })) drop();
        } else if (j.status === "error") {
          clearTimeout(t);
          reject(new RemoteError("failed", `Daytona ${this.box.name}: ${String(j.error ?? "terminal error").slice(0, 120)}`));
        }
      });
      ws.onClose((code, reason) => {
        clearTimeout(t);
        if (!connected) reject(new RemoteError("unreachable", `Daytona ${this.box.name}: the terminal closed (${code})`));
        let exit: number | null = null;
        try {
          const j = JSON.parse(reason);
          if (typeof j?.exitCode === "number") exit = j.exitCode;
        } catch {
          if (code === 1000) exit = 0;
        }
        if (term.end({ code: exit })) drop();
      });
    });
    try {
      await ok;
    } catch (err) {
      ws.close();
      drop();
      throw err;
    }
    ws.send(typed);
    return term;
  }

  keepAlive() {
    const beat = () => {
      http(`${this.l.api}/sandbox/${encodeURIComponent(this.box.id)}/last-activity`, { method: "POST", headers: this.hdrs, timeoutMs: API_TIMEOUT_MS, fetch: this.deps.fetch }).catch(() => {});
    };
    beat();
    const t = setInterval(beat, HEARTBEAT_MS);
    t.unref?.();
    return { dispose: () => clearInterval(t) };
  }
}
