/*
 * Plumbing every remote transport shares: running a local program with a
 * deadline and an output cap, fetch with a deadline, reading another tool's
 * stored login without ever printing it, and the Provider shape that
 * discovery (src/remote/index.ts) drives. Errors carry a coarse code so the
 * office can say "login expired" rather than dump a stack, and their messages
 * are scrubbed so a token echoed back by an API never reaches the terminal.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import type { Host, HostKind, RemoteTarget } from "../shared/events.ts";

export type CloudKind = Exclude<HostKind, "local" | "ssh">;
export type RemoteKind = Exclude<HostKind, "local">;

export type RemoteErrorCode =
  | "auth"        // not logged in, login expired, token refused
  | "missing"     // no credentials / CLI not installed
  | "timeout"
  | "unreachable" // network, 5xx, ssh could not connect
  | "gone"        // sandbox stopped or removed
  | "throttled"   // our own API budget (or the platform's 429) says wait: not the host's fault
  | "failed";     // the script ran and exited non-zero, or a malformed answer

export class RemoteError extends Error {
  constructor(readonly code: RemoteErrorCode, message: string) {
    super(scrubMessage(message));
  }
}

/** Mask token-shaped runs and keep one short line, so an error is safe to print. */
export function scrubMessage(s: string): string {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/\bBearer\s+\S+/gi, "Bearer •••")
    .replace(/\b(token|key|secret|password)\s*[=:]\s*\S+/gi, "$1=•••")
    .replace(/\b[A-Za-z0-9_\-.]{32,}\b/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "•••" : m))
    .trim()
    .slice(0, 200);
}

/* ------------------------------------------------------------- processes */

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  input?: string;
  timeoutMs: number;
  /** stdout beyond this kills the child and rejects (default 64 MB). */
  maxBytes?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run a program (no shell). Rejects only when it cannot start; a non-zero exit resolves. */
export function run(cmd: string, args: string[], o: RunOptions): Promise<RunResult> {
  const max = o.maxBytes ?? 64 << 20;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: o.env ?? process.env, windowsHide: true });
    } catch (err) {
      return reject(new RemoteError("missing", `${cmd}: ${(err as Error).message}`));
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let errSize = 0;
    let timedOut = false;
    let overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, Math.max(1, o.timeoutMs));
    timer.unref?.();
    child.stdout!.on("data", (c: Buffer) => {
      size += c.length;
      if (size > max) {
        if (!overflow) {
          overflow = true;
          kill();
        }
        return;
      }
      out.push(c);
    });
    child.stderr!.on("data", (c: Buffer) => {
      // Only the tail of stderr is ever shown; keep a bounded amount.
      if (errSize < 64 << 10) err.push(c);
      errSize += c.length;
    });
    child.stdin!.on("error", () => {}); // EPIPE when the child exits before reading its input
    child.stderr!.on("error", () => {});
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(new RemoteError(e.code === "ENOENT" ? "missing" : "failed", `${cmd}: ${e.code === "ENOENT" ? "not installed" : e.message}`));
    });
    // Done when the child has exited and stdout is drained. Not "close": a
    // backgrounded ssh ControlPersist master inherits stderr and holds it open.
    let exitCode: number | null | undefined;
    let outDone = false;
    const finish = () => {
      if (exitCode === undefined || !outDone) return;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      setImmediate(() => {
        child.stderr!.destroy();
        if (overflow) return reject(new RemoteError("failed", `${cmd}: output over ${max >> 20} MB`));
        resolve({ code: exitCode!, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
      });
    };
    child.stdout!.on("close", () => {
      outDone = true;
      finish();
    });
    child.on("exit", (code, signal) => {
      exitCode = code ?? (signal ? null : -1);
      finish();
    });
    if (o.input !== undefined) child.stdin!.end(o.input);
    else child.stdin!.end();
  });
}

/** Last non-empty line of a tool's stderr, for an error message. */
export function lastLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

/** Is `bin` an executable on PATH (no spawn)? */
export function which(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (bin.includes("/")) return canRun(bin) ? bin : undefined;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = join(dir, bin + ext.toLowerCase());
      if (canRun(p)) return p;
    }
  }
  return undefined;
}

function canRun(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ http */

export type FetchFn = typeof fetch;

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  fetch?: FetchFn;
  /** Answers bigger than this are refused (default 32 MB): a sandbox is never trusted to size its own reply. */
  maxBytes?: number;
}

/** Most bytes any one API answer may have. */
export const HTTP_MAX_BYTES = 32 << 20;

export interface HttpResult {
  status: number;
  text: string;
  contentType: string;
  header(name: string): string | undefined;
}

/** fetch with a deadline; network failures become RemoteError("unreachable"). */
export async function http(url: string, o: HttpOptions): Promise<HttpResult> {
  const f = o.fetch ?? globalThis.fetch;
  if (!f) throw new RemoteError("missing", "this Node has no fetch (Node >= 18 needed)");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1, o.timeoutMs));
  timer.unref?.();
  try {
    const res = await f(url, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      headers: { accept: "application/json", ...(o.body === undefined ? {} : { "content-type": "application/json" }), ...o.headers },
      body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
      signal: ctl.signal,
    });
    const text = await readCapped(res, o.maxBytes ?? HTTP_MAX_BYTES, url);
    return { status: res.status, text, contentType: res.headers.get("content-type") ?? "", header: (n) => res.headers.get(n) ?? undefined };
  } catch (err) {
    if (err instanceof RemoteError) throw err;
    if (ctl.signal.aborted) throw new RemoteError("timeout", `${new URL(url).host} timed out`);
    throw new RemoteError("unreachable", `${new URL(url).host}: ${(err as Error)?.message ?? err}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The body as text, stopping (and failing) once it passes `max` bytes. */
async function readCapped(res: Response, max: number, url: string): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > max) throw new RemoteError("failed", `${new URL(url).host}: answer over ${max >> 20} MB`);
    return t;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new RemoteError("failed", `${new URL(url).host}: answer over ${max >> 20} MB`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Parse a JSON answer, mapping HTTP failures to RemoteError codes. */
export function jsonOf(r: HttpResult, what: string): any {
  if (r.status === 401 || r.status === 403) throw new RemoteError("auth", `${what}: ${r.status} ${apiMessage(r.text) || "unauthorized"}`);
  if (r.status === 404 || r.status === 410) throw new RemoteError("gone", `${what}: ${r.status} ${apiMessage(r.text) || "not found"}`);
  if (r.status === 429) throw new RemoteError("throttled", `${what}: rate limited`);
  if (r.status >= 500) throw new RemoteError("unreachable", `${what}: ${r.status} ${apiMessage(r.text)}`);
  if (r.status >= 400) throw new RemoteError("failed", `${what}: ${r.status} ${apiMessage(r.text)}`);
  try {
    return JSON.parse(r.text);
  } catch {
    throw new RemoteError("failed", `${what}: answer is not JSON`);
  }
}

/** The human part of an API error body, whatever its shape. */
function apiMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message ?? j?.errors?.[0]?.message ?? j?.error;
    return typeof m === "string" ? m : "";
  } catch {
    return text.slice(0, 120);
  }
}

/* ----------------------------------------------------------- stored logins */

/** Parse a JSON file, or undefined. Callers read single fields; nothing is logged. */
export function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.HOME || env.USERPROFILE || homedir();
}

/** Where a tool keeps per-user config, as Go's os.UserConfigDir does. */
export function userConfigDir(env: NodeJS.ProcessEnv, platform = process.platform): string {
  const home = homeOf(env);
  if (platform === "darwin") return join(home, "Library", "Application Support");
  if (platform === "win32") return env.APPDATA || join(home, "AppData", "Roaming");
  return env.XDG_CONFIG_HOME || join(home, ".config");
}

/** Claims of an unverified JWT (team/project ids in an OIDC token). Never used to trust anything. */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const j = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return j && typeof j === "object" ? j : undefined;
  } catch {
    return undefined;
  }
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

/* -------------------------------------------------------------- providers */

export interface Discovered {
  host: Host;
  /** The same object every listing, so a watcher keeps working across rediscovery. */
  target: RemoteTarget;
  /** Minutes of inactivity after which the sandbox stops itself (0 or unset: never). */
  idleStopMin?: number;
  /** Provider-side last activity (epoch ms), when the API reports one. */
  activityAt?: number;
  /** How often its watcher may poll, when the platform's API has a tight rate limit. */
  pollMs?: number;
}

export type Scope = "auto" | "all";

export interface Availability {
  ok: boolean;
  /** "api key", "CLI login", ... for the log. */
  via?: string;
  /** Why not, as a hint the user can act on. */
  why?: string;
}

export interface Provider {
  kind: CloudKind;
  label: string;
  /** Exec polling counts as activity, so polling a quiet sandbox would keep it from idling out. */
  keepsAwake: boolean;
  /** Cheap and offline: is there a login or a CLI to try? */
  available(): Availability;
  /**
   * Running sandboxes. "all" (the default, and what `--<platform> all` asks for) is everything
   * the login can see; "auto" (plain `npx theagentoffice`) is only the user's own scope: the
   * default team, the linked project, sandboxes this user's CLI made. Rejects with RemoteError
   * when the listing itself fails.
   */
  list(scope?: Scope): Promise<Discovered[]>;
  /** false: never watched unless asked for by name or `--<platform> all` (boat keeps every poll's output). */
  autoDetect?: boolean;
  /** One line on what "auto" covers, for the banner and README ("default team only"). */
  autoScope?: string;
  /** List this often at most (default DISCOVER_MS, 30s). */
  discoverMs?: number;
}

export interface ProviderOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: FetchFn;
  platform?: NodeJS.Platform;
  /** Per exec and per API call. */
  timeoutMs?: number;
  now?: () => number;
  /** Override the CLI binary (tests). */
  bin?: string;
  cwd?: string;
}

/** "all", an exact id or name, or a unique id prefix (>= 4 chars). */
export function pick(found: Discovered[], sel: string, idOf: (d: Discovered) => string[]): Discovered[] {
  if (!sel || sel === "all") return found;
  const exact = found.filter((d) => idOf(d).includes(sel));
  if (exact.length) return exact;
  if (sel.length < 4) return [];
  const pre = found.filter((d) => idOf(d).some((x) => x.startsWith(sel)));
  return pre.length === 1 ? pre : [];
}

/** Cap a display name (sandbox names are user-chosen). */
export function displayName(s: string, max = 40): string {
  const t = s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return [...t].length > max ? [...t].slice(0, max - 1).join("") + "…" : t;
}
