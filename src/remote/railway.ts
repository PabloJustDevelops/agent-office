/*
 * Railway Sandboxes as RemoteTargets. Two transports, picked per call:
 *
 *  - GraphQL (https://backboard.railway.com/graphql/v2) with fetch, whenever a
 *    token is at hand: RAILWAY_API_TOKEN (account or workspace token),
 *    RAILWAY_TOKEN (a project token: its one environment), or the access token
 *    the logged-in railway CLI keeps in ~/.railway/config.json while it is
 *    unexpired. Discovery walks me.workspaces -> projects -> environments
 *    (cached 5 min) and asks every environment for its active sandboxes in
 *    one aliased query. Exec is the sandboxExec mutation, which caps each
 *    stream at 16,000 bytes: the script's output goes to a temp file in the
 *    sandbox, and anything bigger is gzipped there and paged back in
 *    newline-aligned slices.
 *  - The railway CLI, when the stored token has expired (running the CLI
 *    refreshes it, and the next call is back on GraphQL): `railway list
 *    --json`, `railway sandbox list --json -p -e`, `railway sandbox exec
 *    --id -p -e --timeout -- sh -c <script>`.
 *
 * Railway's API allows 1,000 requests an hour on Hobby (10,000 on Pro, read
 * from the RateLimit-Policy header), and the CLI spends from the same pot.
 * The office keeps to under half of it: discovery runs every 2 minutes, each
 * sandbox gets an even share of the rest as a token bucket (a poll that had
 * to page simply waits longer before the next one, so the pace follows what
 * polls really cost), reads are kept small so a poll fits one answer, and a
 * sliding-window budget refuses calls past the share as "throttled", which
 * the watcher backs off from without calling the sandbox offline. Polling
 * also counts as activity, so discovery reports each sandbox's
 * idleTimeoutMinutes and the remote manager stops polling a quiet one well
 * before that (see src/remote/index.ts).
 *
 * Scope: `--railway all` (or an id) looks in every workspace the token sees.
 * Auto-detection only looks where this user works: the project and
 * environment `railway link` tied to the current folder, plus the sandboxes
 * the user's own CLI created (its config records them). Nothing here
 * creates, forks or destroys a sandbox. Tokens are read, never printed or
 * written.
 */
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { RemoteTarget } from "../shared/events.ts";
import { shQuote, type TunedTarget } from "./source.ts";
import {
  RemoteError, displayName, homeOf, http, jsonOf, lastLine, pick, readJson, run, str, which,
  type Availability, type Discovered, type HttpResult, type Provider, type ProviderOptions, type Scope,
} from "./util.ts";

export const RAILWAY_GQL = "https://backboard.railway.com/graphql/v2";
const ENVS_TTL_MS = 5 * 60_000;
const DISCOVER_MS = 2 * 60_000;
/** The share of the hourly API quota the office lets itself use. */
const SHARE = 0.45;
/** Requests an hour kept for discovery out of that share (a listing every 2 min, projects every 5). */
const DISCOVERY_RESERVE = 80;
/** sandboxExec returns at most 16,000 bytes per stream; stay under it. */
export const RAILWAY_EXEC_CAP = 15_000;
/** A paged answer bigger than this is refused rather than fetched (100 calls of the hourly quota). */
const MAX_PAGED = 100 * RAILWAY_EXEC_CAP;
/** Reads per poll, small enough that a typical poll (gzipped) fits one answer. */
const READ_LIMITS = { prefetchBytes: 48 << 10, maxReadBytes: 96 << 10, maxBatchBytes: 384 << 10 };
/** Requests a sandbox may spend in a burst before its share's pace applies. */
const BURST = 12;
/** A sandbox whose share needs a longer wait than this is skipped for the round ("throttled"). */
const MAX_WAIT_MS = 45_000;

interface Token {
  token: string;
  project: boolean;
  via: string;
}

interface Env {
  projectId: string;
  projectName: string;
  environmentId: string;
}

interface Box extends Env {
  id: string;
  name: string;
}

/** A usable API token, or why not (no network). */
export function railwayToken(o: ProviderOptions = {}): Token | { why: string; code: "missing" | "auth"; expired?: boolean } {
  const env = o.env ?? process.env;
  const now = (o.now ?? Date.now)();
  const api = str(env.RAILWAY_API_TOKEN);
  if (api) return { token: api, project: false, via: "RAILWAY_API_TOKEN" };
  const proj = str(env.RAILWAY_TOKEN);
  if (proj) return { token: proj, project: true, via: "RAILWAY_TOKEN" };
  const user = readJson(join(homeOf(env), ".railway", "config.json"))?.user;
  const access = str(user?.accessToken);
  if (access) {
    const exp = typeof user.tokenExpiresAt === "number" ? user.tokenExpiresAt * 1000 : Infinity;
    if (exp > now + 60_000) return { token: access, project: false, via: "railway CLI login" };
    return { code: "auth", why: "railway CLI login expired", expired: true };
  }
  const legacy = str(user?.token);
  if (legacy) return { token: legacy, project: false, via: "railway CLI login" };
  return { code: "missing", why: "not logged in (run `railway login`, or set RAILWAY_API_TOKEN)" };
}

/** A sliding-window request budget, sized from Railway's RateLimit-Policy header. */
export class RailwayBudget {
  quota = 1_000;
  windowMs = 3_600_000;
  private stamps: number[] = [];
  private retryAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  take(n = 1): void {
    const t = this.now();
    if (t < this.retryAt) throw new RemoteError("throttled", `Railway API rate limit reached: waiting ${Math.ceil((this.retryAt - t) / 1000)}s`);
    while (this.stamps.length && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
    if (this.stamps.length + n > this.quota * SHARE) throw new RemoteError("throttled", "pausing to stay well inside Railway's API rate limit");
    for (let i = 0; i < n; i++) this.stamps.push(t);
  }

  observe(r: HttpResult): void {
    const pol = r.header("ratelimit-policy") ?? ""; // "default";q=1000;w=3600
    const q = Number(pol.match(/q=(\d+)/)?.[1]);
    const w = Number(pol.match(/w=(\d+)/)?.[1]);
    if (q > 0) this.quota = q;
    if (w > 0) this.windowMs = w * 1000;
    if (r.status === 429) {
      const after = Number(r.header("retry-after"));
      this.retryAt = this.now() + (after > 0 ? after * 1000 : 60_000);
    }
  }

  /** Poll interval that lets `n` sandboxes share the budget, at one request a poll. */
  pollMs(n: number): number {
    return Math.min(120_000, Math.max(2_500, Math.ceil(this.msPerRequest(n))));
  }

  /** Each of `n` sandboxes may spend one request this often. */
  msPerRequest(n: number): number {
    const perWindow = Math.max(1, this.quota * SHARE - DISCOVERY_RESERVE * (this.windowMs / 3_600_000));
    return (this.windowMs * Math.max(1, n)) / perWindow;
  }

  get used(): number {
    return this.stamps.length;
  }
}

export function createRailwayProvider(o: ProviderOptions & { budget?: RailwayBudget } = {}): Provider {
  const env = o.env ?? process.env;
  const budget = o.budget ?? new RailwayBudget(o.now);
  const timeoutMs = o.timeoutMs ?? 20_000;
  const endpoint = str(env.RAILWAY_GRAPHQL_ENDPOINT) ?? RAILWAY_GQL;
  const bin = o.bin ?? "railway";
  const cache = new Map<string, { d: Discovered; box: Box }>();
  let envsCache: { at: number; key: string; envs: Env[] } | undefined;
  /** Running sandboxes at the last listing: how many share the budget. */
  let running = 1;
  const clock = o.now ?? Date.now;

  const cli = () => (o.bin ? o.bin : which(bin, env));

  async function gql(t: Token, query: string, variables: Record<string, unknown>, ms = timeoutMs, spend?: () => void): Promise<any> {
    const headers: Record<string, string> = t.project ? { "project-access-token": t.token } : { authorization: `Bearer ${t.token}` };
    budget.take();
    spend?.();
    const r = await http(endpoint, { method: "POST", headers, body: { query, variables }, timeoutMs: ms, fetch: o.fetch });
    budget.observe(r);
    const j = jsonOf(r, "Railway API");
    if (Array.isArray(j?.errors) && j.errors.length) {
      const msg = String(j.errors[0]?.message ?? "error");
      const code = /not authorized|unauthorized|authentication|invalid token|forbidden/i.test(msg) ? "auth" : /not found/i.test(msg) ? "gone" : "failed";
      throw new RemoteError(code, `Railway: ${msg}`);
    }
    return j?.data ?? {};
  }

  async function railwayCli(args: string[], ms = timeoutMs): Promise<string> {
    const path = cli();
    if (!path) throw new RemoteError("missing", "Railway: railway CLI not installed");
    budget.take(2); // the CLI makes its own API calls; count them conservatively
    const r = await run(path, args, { timeoutMs: ms + 5_000, env });
    if (r.timedOut || r.code === 124) throw new RemoteError("timeout", `Railway: \`railway ${args[0]} ${args[1] ?? ""}\` timed out`);
    if (r.code !== 0) {
      const why = lastLine(r.stderr) || lastLine(r.stdout);
      throw new RemoteError(/unauthor|log ?in|token/i.test(why) ? "auth" : "failed", `Railway CLI: ${why || `exit ${r.code}`}`);
    }
    return r.stdout;
  }

  /* ---------- discovery ---------- */

  async function envsViaApi(t: Token): Promise<Env[]> {
    if (t.project) {
      const d = await gql(t, "query { projectToken { projectId environmentId project { name } } }", {});
      const p = d.projectToken;
      return p?.environmentId ? [{ projectId: p.projectId, projectName: p.project?.name ?? "project", environmentId: p.environmentId }] : [];
    }
    const me = await gql(t, "query { me { workspaces { id } } }", {});
    // Workspaces in parallel: discovery is on the startup path.
    const per = await Promise.all((me.me?.workspaces ?? []).map(async (w: { id: string }) => {
      const out: Env[] = [];
      let after: string | undefined;
      for (let page = 0; page < 10; page++) {
        const d = await gql(
          t,
          "query($w: String!, $after: String) { projects(workspaceId: $w, first: 100, after: $after) { edges { node { id name environments { edges { node { id } } } } } pageInfo { hasNextPage endCursor } } }",
          { w: w.id, after },
        );
        for (const { node } of d.projects?.edges ?? []) {
          for (const { node: e } of node.environments?.edges ?? []) out.push({ projectId: node.id, projectName: node.name, environmentId: e.id });
        }
        if (!d.projects?.pageInfo?.hasNextPage) break;
        after = d.projects.pageInfo.endCursor;
      }
      return out;
    }));
    return per.flat();
  }

  async function envsViaCli(): Promise<Env[]> {
    const j = JSON.parse(await railwayCli(["list", "--json"]));
    const out: Env[] = [];
    for (const p of Array.isArray(j) ? j : []) {
      for (const e of p?.environments?.edges ?? []) {
        if (str(p.id) && str(e?.node?.id) && e.node.canAccess !== false) out.push({ projectId: p.id, projectName: p.name ?? "project", environmentId: e.node.id });
      }
    }
    return out;
  }

  async function environments(t: Token | undefined): Promise<Env[]> {
    const key = t ? (t.project ? "p:" : "a:") + t.via : "cli";
    const now = (o.now ?? Date.now)();
    if (envsCache && envsCache.key === key && now - envsCache.at < ENVS_TTL_MS) return envsCache.envs;
    const envs = t ? await envsViaApi(t) : await envsViaCli();
    envsCache = { at: now, key, envs };
    return envs;
  }

  /** Raw sandbox rows {id, status, idleTimeoutMinutes} per environment. */
  async function sandboxes(t: Token | undefined, envs: Env[]): Promise<{ s: any; e: Env }[]> {
    const rows: { s: any; e: Env }[] = [];
    if (t) {
      for (let i = 0; i < envs.length; i += 25) {
        const slice = envs.slice(i, i + 25);
        const vars: Record<string, string> = {};
        const defs = slice.map((_, k) => `$e${k}: String!`).join(", ");
        const body = slice
          .map((e, k) => {
            vars[`e${k}`] = e.environmentId;
            return `e${k}: sandboxes(environmentId: $e${k}, active: true, first: 50) { edges { node { id status idleTimeoutMinutes } } }`;
          })
          .join("\n");
        const d = await gql(t, `query(${defs}) {\n${body}\n}`, vars);
        slice.forEach((e, k) => {
          for (const { node } of d[`e${k}`]?.edges ?? []) rows.push({ s: node, e });
        });
      }
      return rows;
    }
    for (const e of envs) {
      const out = await railwayCli(["sandbox", "list", "--json", "-p", e.projectId, "-e", e.environmentId]);
      const j = JSON.parse(out.slice(Math.max(0, out.indexOf("["))) || "[]");
      for (const s of Array.isArray(j) ? j : []) rows.push({ s, e });
    }
    return rows;
  }

  /* ---------- exec ---------- */

  async function sandboxExec(t: Token, box: Box, command: string, ms: number, spend?: () => void): Promise<string> {
    const d = await gql(
      t,
      "mutation($e: String!, $id: String!, $c: String!, $t: Int) { sandboxExec(environmentId: $e, id: $id, command: $c, timeoutSec: $t) { exitCode stdout truncated timedOut } }",
      { e: box.environmentId, id: box.id, c: command, t: Math.max(1, Math.ceil(ms / 1000)) },
      ms + 5_000,
      spend,
    );
    const x = d.sandboxExec;
    if (!x) throw new RemoteError("failed", `Railway ${box.name}: no exec result`);
    if (x.timedOut) throw new RemoteError("timeout", `Railway ${box.name}: timed out`);
    if (x.exitCode !== 0) throw new RemoteError("failed", `Railway ${box.name}: exit ${x.exitCode}`);
    if (x.truncated) throw new RemoteError("failed", `Railway ${box.name}: output truncated`);
    return typeof x.stdout === "string" ? x.stdout : "";
  }

  async function execApi(t: Token, box: Box, script: string, ms: number, spend?: () => void): Promise<string> {
    const first = await sandboxExec(t, box, pagedScript(script), ms, spend);
    const m = first.match(PAGED);
    if (!m) return first;
    const file = m[1]!;
    const size = Number(m[2]);
    const gz = m[3] === "gz";
    if (!(size <= MAX_PAGED)) {
      await sandboxExec(t, box, `rm -f ${shQuote(file)}`, ms, spend).catch(() => {});
      throw new RemoteError("failed", `Railway ${box.name}: answer too big to page (${Math.round(size / 1024)} KB)`);
    }
    let off = 0;
    let out = "";
    while (off < size) {
      const last = off + RAILWAY_EXEC_CAP >= size;
      const cmd = `tail -c +${off + 1} ${shQuote(file)} | head -c ${RAILWAY_EXEC_CAP}${last ? `; rm -f ${shQuote(file)}` : ""}`;
      const chunk = await sandboxExec(t, box, cmd, ms, spend);
      if (last) {
        out += chunk;
        break;
      }
      // Keep whole lines, so a multi-byte character split at the slice edge is re-read whole next time.
      const nl = chunk.lastIndexOf("\n");
      const keep = nl >= 0 ? chunk.slice(0, nl + 1) : chunk;
      const used = nl >= 0 ? Buffer.byteLength(keep, "utf8") : RAILWAY_EXEC_CAP;
      if (used <= 0) break;
      out += keep;
      off += used;
    }
    if (!gz) return out;
    try {
      return gunzipSync(Buffer.from(out.replace(/[^A-Za-z0-9+/=]/g, ""), "base64"), { maxOutputLength: 32 << 20 }).toString("utf8");
    } catch {
      throw new RemoteError("failed", `Railway ${box.name}: paged output was cut short`);
    }
  }

  async function execCli(box: Box, script: string, ms: number): Promise<string> {
    return railwayCli(
      ["sandbox", "exec", "--id", box.id, "-p", box.projectId, "-e", box.environmentId, "--timeout", String(Math.max(1, Math.ceil(ms / 1000))), "--", "sh", "-c", script],
      ms,
    );
  }

  /** The API when a token works, else the CLI (which also refreshes its stored login). */
  function transport(): Token | "cli" {
    const t = railwayToken(o);
    if (!("why" in t)) return t;
    if (cli()) return "cli";
    throw new RemoteError(t.code, `Railway: ${t.why}`);
  }

  function targetFor(box: Box): RemoteTarget {
    // This sandbox's share of the budget as a token bucket: bursts are fine, the average is held.
    let tokens = BURST;
    let at = clock();
    const refill = () => {
      const now = clock();
      tokens = Math.min(BURST, tokens + (now - at) / budget.msPerRequest(running));
      at = now;
    };
    const spend = () => {
      refill();
      tokens -= 1;
    };
    const target: TunedTarget = {
      host: { kind: "railway", id: `railway:${box.id}`, name: box.name },
      readLimits: READ_LIMITS,
      async exec(script, eo) {
        const ms = eo?.timeoutMs ?? timeoutMs;
        const t = transport();
        refill();
        if (tokens < 1) {
          const wait = (1 - tokens) * budget.msPerRequest(running);
          if (wait > MAX_WAIT_MS) throw new RemoteError("throttled", `Railway ${box.name}: waiting for its share of the API budget`);
          await new Promise((r) => setTimeout(r, wait).unref?.());
        }
        if (t === "cli") {
          spend();
          spend(); // the CLI makes its own API calls
          return execCli(box, script, ms);
        }
        return execApi(t, box, script, ms, spend);
      },
    };
    return target;
  }

  return {
    kind: "railway",
    label: "Railway",
    keepsAwake: true,
    discoverMs: DISCOVER_MS,
    autoScope: "the linked project and the sandboxes your railway CLI created",
    available(): Availability {
      const t = railwayToken(o);
      if (!("why" in t)) return { ok: true, via: t.via };
      if (cli() && (t.expired || readJson(join(homeOf(env), ".railway", "config.json"))?.user)) return { ok: true, via: "railway CLI" };
      return { ok: t.code === "auth", why: t.why };
    },
    async list(scope: Scope = "all") {
      const t = transport();
      const tok = t === "cli" ? undefined : t;
      const all = await environments(tok);
      const mine = scope === "auto" ? ownScope(env, o.cwd ?? process.cwd()) : undefined;
      const envs = mine ? all.filter((e) => mine.envs.has(e.environmentId) || mine.boxes.has(e.environmentId)) : all;
      const rows = (await sandboxes(tok, envs)).filter(({ s, e }) => {
        if (!mine || mine.envs.has(e.environmentId)) return true;
        return !!mine.boxes.get(e.environmentId)?.has(str(s?.id) ?? "");
      });
      const out: Discovered[] = [];
      const seen = new Set<string>();
      running = Math.max(1, rows.filter(({ s }) => str(s?.id) && s.status === "RUNNING").length);
      for (const { s, e } of rows) {
        const id = str(s?.id);
        if (!id || s.status !== "RUNNING") continue;
        seen.add(id);
        let hit = cache.get(id);
        if (!hit) {
          const box: Box = { ...e, id, name: displayName(`${e.projectName}:${id.slice(0, 6)}`) };
          const target = targetFor(box);
          hit = { box, d: { host: target.host, target } };
          cache.set(id, hit);
        }
        hit.d.idleStopMin = typeof s.idleTimeoutMinutes === "number" ? s.idleTimeoutMinutes : 30;
        hit.d.pollMs = budget.pollMs(running);
        out.push(hit.d);
      }
      for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
      return out;
    },
  };
}

/**
 * Where this user works, from the railway CLI's own config: the environment `railway link` tied
 * to `cwd` (or a folder above it), and the sandboxes the CLI created (by environment). Empty when
 * there is no CLI config: auto-detection then watches nothing on Railway.
 */
export function ownScope(env: NodeJS.ProcessEnv, cwd: string): { envs: Set<string>; boxes: Map<string, Set<string>> } {
  const cfg = readJson(join(homeOf(env), ".railway", "config.json"));
  const envs = new Set<string>();
  const boxes = new Map<string, Set<string>>();
  const linked = cfg?.projects && typeof cfg.projects === "object" ? cfg.projects : {};
  let best = "";
  for (const [dir, p] of Object.entries<any>(linked)) {
    const d = dir.replace(/\/+$/, "");
    if ((cwd === d || cwd.startsWith(d + "/")) && d.length > best.length && str(p?.environment)) best = d;
  }
  if (best) envs.add(str((linked as any)[best].environment)!);
  const made = cfg?.sandboxes && typeof cfg.sandboxes === "object" ? cfg.sandboxes : {};
  for (const sb of Object.values<any>(made)) {
    const e = str(sb?.environmentId), id = str(sb?.id);
    if (e && id) (boxes.get(e) ?? boxes.set(e, new Set()).get(e)!).add(id);
  }
  return { envs, boxes };
}

const PAGED = /^@@agentoffice-paged (\/tmp\/\.agentoffice-[A-Za-z0-9._-]+) (\d+) (gz|raw)\n?$/;

/**
 * Run the script into a temp file; print it if it fits one answer, else say
 * where it is, how big, and whether it was gzipped (base64 of gzip: polls are
 * mostly base64 of JSON, which shrinks ~7x, so a 256 KB read is ~3 pages).
 */
export function pagedScript(script: string, cap = RAILWAY_EXEC_CAP): string {
  return [
    `t=$(mktemp /tmp/.agentoffice-XXXXXXXX 2>/dev/null) || t=/tmp/.agentoffice-$$`,
    `find /tmp -maxdepth 1 -name '.agentoffice-*' -mmin +10 -exec rm -f {} + 2>/dev/null`,
    `sh -c ${shQuote(script)} >"$t" 2>/dev/null; rc=$?`,
    `if [ "$rc" -ne 0 ]; then rm -f "$t"; exit "$rc"; fi`,
    `n=$(wc -c <"$t" | tr -d ' ')`,
    `if [ "$n" -le ${cap} ]; then cat "$t"; rm -f "$t"; exit 0; fi`,
    `e=raw`,
    `if command -v gzip >/dev/null 2>&1 && command -v base64 >/dev/null 2>&1 && gzip -c <"$t" >"$t.gz" 2>/dev/null && base64 <"$t.gz" >"$t.z" 2>/dev/null; then mv -f "$t.z" "$t"; e=gz; n=$(wc -c <"$t" | tr -d ' '); fi`,
    `rm -f "$t.gz" "$t.z"`,
    `printf '@@agentoffice-paged %s %s %s\\n' "$t" "$n" "$e"`,
    "",
  ].join("\n");
}

/** For `--railway <all|id>` and the installer. */
export async function createRailwayTargets(sel = "all", o: ProviderOptions = {}): Promise<RemoteTarget[]> {
  const found = await createRailwayProvider(o).list();
  return pick(found, sel, (d) => [d.host.id.slice("railway:".length), d.host.name]).map((d) => d.target);
}
