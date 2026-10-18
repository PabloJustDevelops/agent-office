/*
 * The office's memory. Folds RawEvents from ingest (or the demo) into one
 * WorkerState per worker, stamps each event with a seq, keeps the last
 * RECENT_MAX for clients that connect late, and makes up the events no
 * transcript ever writes: "idle" after IDLE_MS of quiet, "session_end" after
 * GONE_MS. It also re-sanitises every event on the way in, so a bug upstream
 * cannot put a long or secret-looking string on screen. Time comes from an
 * injected clock so tests can fast-forward it. Workers on other machines
 * carry their Host; the four kinds agents send through MCP (status, shout,
 * celebrate, flip) never create a worker or change its pose: status sets the
 * worker's mood line, the others are passed through for the client to play.
 */
import { homedir } from "node:os";
import { foldPrivate } from "../ingest/presence.ts";
import {
  GONE_MS,
  IDLE_MS,
  SUMMARY_MAX,
  type AgentKind,
  type EventKind,
  type Host,
  type HostKind,
  type OfficeEvent,
  type RawEvent,
  type Snapshot,
  type ToolCategory,
  type WorkerState,
} from "../shared/events.ts";

export const RECENT_MAX = 200;
/** How long an intern lingers after subagent_end so the client can walk it out. */
export const INTERN_GRACE_MS = 6_000;

const AGENTS = new Set<AgentKind>(["claude", "commandcode", "codex", "opencode", "droid", "gemini", "qwen", "cursor"]);
const HOSTS = new Set<HostKind>(["local", "ssh", "daytona", "boat", "railway", "vercel"]);
const KINDS = new Set<EventKind>([
  "session_start", "prompt", "thinking", "tool_start", "tool_end", "reply", "waiting",
  "test_fail", "test_pass", "error", "subagent_start", "subagent_end", "idle", "session_end",
  "status", "shout", "celebrate", "flip",
]);
/** Sent by the agent itself (MCP): only for workers already in the office, and they leave the pose alone. */
const SIGNALS = new Set<EventKind>(["status", "shout", "celebrate", "flip"]);
/** Prefixed worker ids from remotes ("vercel:sbx_.../<session>") are longer than local ones. */
const ID_MAX = 200;
const CATEGORIES = new Set<ToolCategory>([
  "read", "edit", "bash", "search", "web", "agent", "todo", "mcp", "other",
]);
/**
 * An intern counts as at work for this long after its last line. A session whose
 * turn ended while its interns work is supervising them, not waiting on its human.
 */
const SUPERVISE_MS = 5 * 60_000;
/** A local session with no agent process left goes home once it has been quiet this long. */
export const PRESENCE_QUIET_MS = 15_000;
/** Events that only describe an existing worker; never create one. */
const ENDINGS = new Set<EventKind>(["session_end", "subagent_end", "idle"]);

export interface StateOptions {
  demo?: boolean;
  /** Clock in epoch ms. Defaults to Date.now. */
  now?: () => number;
  idleMs?: number;
  goneMs?: number;
  internGraceMs?: number;
  recentMax?: number;
  /** cwd prefix shown as "~". Defaults to os.homedir(); null keeps cwd as is. */
  home?: string | null;
}

export type Listener = (event: OfficeEvent) => void;

interface Worker {
  state: WorkerState;
  files: Set<string>;
  /** Clock ms of the last real (non-synthetic) activity. */
  lastActive: number;
  /** Set by subagent_end: drop the intern from the map at this time. */
  removeAt?: number;
  /** Its turn ended while interns worked: it needs its human once they are done. */
  heldWait?: boolean;
}

export class OfficeState {
  readonly demo: boolean;
  readonly startedAt: string;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly goneMs: number;
  private readonly graceMs: number;
  private readonly home: string | null;
  private readonly ring: (OfficeEvent | undefined)[];
  private ringHead = 0;
  private ringSize = 0;
  private seq = 0;
  private readonly workers = new Map<string, Worker>();
  private readonly listeners = new Set<Listener>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: StateOptions = {}) {
    this.demo = opts.demo ?? false;
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.goneMs = opts.goneMs ?? GONE_MS;
    this.graceMs = opts.internGraceMs ?? INTERN_GRACE_MS;
    this.ring = new Array(Math.max(1, opts.recentMax ?? RECENT_MAX));
    const home = opts.home === undefined ? homedir() : opts.home;
    this.home = home ? home.replace(/[\\/]+$/, "") : null;
    this.startedAt = new Date(this.now()).toISOString();
  }

  /** Fold one event in. Returns the published event, or null if it was dropped. */
  ingest(raw: RawEvent): OfficeEvent | null {
    let e = this.sanitize(raw);
    if (!e) return null;
    const now = this.now();
    let w = this.workers.get(e.workerId);

    if (!w) {
      if (ENDINGS.has(e.kind) || SIGNALS.has(e.kind)) return null;
      w = this.create(e, now);
      // A client can only animate a worker it has seen arrive.
      if (e.kind !== "session_start" && e.kind !== "subagent_start") {
        this.publish({ ...this.base(w, e.ts), kind: e.parentId ? "subagent_start" : "session_start" });
      }
    } else if ((e.kind === "session_start" || e.kind === "subagent_start") && w.removeAt === undefined) {
      // Re-sighting (backfill then live tail): refresh metadata, don't respawn.
      this.merge(w, e);
      this.touch(w, e.ts, now);
      return null;
    } else if (e.kind === "idle" && w.state.status === "idle") {
      return null;
    } else if (e.kind === "subagent_end" && w.removeAt !== undefined) {
      return null;
    } else if (SIGNALS.has(e.kind)) {
      if (w.removeAt !== undefined) return null;
      if (e.kind === "status") this.setMood(w, e);
      this.touch(w, e.ts, now);
      return this.publish(e);
    }

    if (e.kind === "session_end") return this.remove(w, e);
    if (!e.parentId && e.kind !== "idle") w.heldWait = undefined;
    if (!e.parentId && e.kind === "waiting" && this.busyInterns(w, now)) e = this.supervise(w, e.ts, now);
    this.fold(w, e, now);
    const out = this.publish(e);
    // Interns that show up after their boss's turn ended turn the waiting into supervising.
    const boss = e.parentId ? this.workers.get(e.parentId) : undefined;
    if (boss && boss.state.status === "waiting" && boss.removeAt === undefined && this.busyInterns(boss, now)) {
      const held = this.supervise(boss, e.ts, now);
      this.fold(boss, held, now);
      this.publish(held);
    }
    return out;
  }

  /** Interns of this session that are still at work. */
  private busyInterns(w: Worker, now: number): number {
    let n = 0;
    for (const c of this.workers.values()) {
      if (c.state.parentId === w.state.workerId && c.removeAt === undefined && now - c.lastActive < SUPERVISE_MS) n++;
    }
    return n;
  }

  /** The boss leans back and watches; the waiting is held until the interns are done. */
  private supervise(w: Worker, ts: string, now: number): RawEvent {
    w.heldWait = true;
    const n = this.busyInterns(w, now);
    return { ...this.base(w, ts), kind: "idle", summary: `supervising ${n} intern${n === 1 ? "" : "s"}` };
  }

  /**
   * Send home local sessions whose agent has quit. Per agent and folder the
   * office keeps as many sessions as there are running processes (the most
   * recently active ones) and ends the rest once they have been quiet for
   * PRESENCE_QUIET_MS. Remote workers are left to the quiet timer.
   */
  reconcileLocal(procs: { agent: AgentKind; cwd: string }[]): void {
    const now = this.now();
    const key = (agent: AgentKind, cwd: string) => `${agent}\0${foldPrivate(cwd)}`;
    const running = new Map<string, number>();
    for (const p of procs) {
      const k = key(p.agent, this.tilde(p.cwd));
      running.set(k, (running.get(k) ?? 0) + 1);
    }
    const groups = new Map<string, Worker[]>();
    for (const w of this.workers.values()) {
      const s = w.state;
      if (s.parentId || s.host || !s.cwd || w.removeAt !== undefined) continue;
      const k = key(s.agent, s.cwd);
      const g = groups.get(k);
      if (g) g.push(w);
      else groups.set(k, [w]);
    }
    const ts = new Date(now).toISOString();
    for (const [k, ws] of groups) {
      const extra = ws.length - (running.get(k) ?? 0);
      if (extra <= 0) continue;
      ws.sort((a, b) => a.lastActive - b.lastActive);
      for (const w of ws.slice(0, extra)) {
        if (now - w.lastActive >= PRESENCE_QUIET_MS) this.remove(w, { ...this.base(w, ts), kind: "session_end" });
      }
    }
  }

  /** Emit idle / session_end for workers that went quiet. Called every second by start(). */
  tick(): void {
    const now = this.now();
    for (const w of [...this.workers.values()]) {
      if (!this.workers.has(w.state.workerId)) continue; // removed with its parent
      if (w.removeAt !== undefined) {
        if (now >= w.removeAt) this.workers.delete(w.state.workerId);
        continue;
      }
      const quiet = now - w.lastActive;
      const ts = new Date(now).toISOString();
      const supervising = !w.state.parentId && this.busyInterns(w, now) > 0;
      if (w.heldWait && !supervising) {
        // The interns are done and nothing moved since: now it is the human's turn.
        w.heldWait = undefined;
        const e: RawEvent = { ...this.base(w, ts), kind: "waiting" };
        this.fold(w, e, now);
        this.publish(e);
        continue;
      }
      if (quiet >= this.goneMs && !supervising) {
        this.remove(w, { ...this.base(w, ts), kind: w.state.parentId ? "subagent_end" : "session_end" });
      } else if (quiet >= this.idleMs && w.state.status !== "idle" && w.state.status !== "waiting") {
        // A worker waiting on its human still needs them however long it waits; it only goes home.
        const e: RawEvent = { ...this.base(w, ts), kind: "idle" };
        this.fold(w, e, now);
        this.publish(e);
      }
    }
  }

  snapshot(): Snapshot {
    return {
      version: 1,
      startedAt: this.startedAt,
      demo: this.demo,
      workers: [...this.workers.values()].map((w) => ({ ...w.state })),
      recent: this.recent(),
    };
  }

  /** Last <= recentMax events, oldest first. */
  recent(): OfficeEvent[] {
    const out: OfficeEvent[] = [];
    const cap = this.ring.length;
    const start = (this.ringHead - this.ringSize + cap) % cap;
    for (let i = 0; i < this.ringSize; i++) out.push(this.ring[(start + i) % cap]!);
    return out;
  }

  /** Empty the office (the demo starting over for a new viewer). Sequence numbers keep counting. */
  reset(): void {
    this.workers.clear();
    this.ring.fill(undefined);
    this.ringHead = this.ringSize = 0;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Workers currently in the office (sessions and interns). */
  get size(): number {
    return this.workers.size;
  }

  /** Top-level sessions currently in the office. */
  sessions(): WorkerState[] {
    return [...this.workers.values()]
      .filter((w) => !w.state.parentId && w.removeAt === undefined)
      .map((w) => ({ ...w.state }));
  }

  start(intervalMs = 1_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private create(e: RawEvent, now: number): Worker {
    const w: Worker = {
      state: {
        workerId: e.workerId,
        agent: e.agent,
        project: e.project,
        status: e.kind,
        lastTs: e.ts,
        toolCalls: 0,
        tokens: 0,
        filesTouched: 0,
      },
      files: new Set(),
      lastActive: Number.NEGATIVE_INFINITY,
    };
    this.merge(w, e);
    this.touch(w, e.ts, now);
    this.workers.set(e.workerId, w);
    return w;
  }

  /** "🔥 refactoring auth": the emoji (event.tool) and the status line (event.summary), either optional. */
  private setMood(w: Worker, e: RawEvent): void {
    const mood = [e.tool, e.summary].filter(Boolean).join(" ");
    if (mood) w.state.mood = cap(mood, SUMMARY_MAX + 9);
    else delete w.state.mood;
  }

  private merge(w: Worker, e: RawEvent): void {
    const s = w.state;
    if (e.host) s.host = e.host;
    if (e.parentId) s.parentId = e.parentId;
    if (e.project) s.project = e.project;
    if (e.cwd) s.cwd = e.cwd;
    if (e.model) s.model = e.model;
    if (e.role) s.role = e.role;
  }

  private fold(w: Worker, e: RawEvent, now: number): void {
    const s = w.state;
    this.merge(w, e);
    s.status = e.kind;
    s.lastTs = e.ts;
    if (e.kind === "tool_start") {
      s.toolCalls++;
      s.tool = e.tool;
      s.category = e.category;
      s.summary = e.summary;
      if (e.category === "edit" && e.summary) {
        for (const f of editedFiles(e.summary)) w.files.add(f);
        s.filesTouched = w.files.size;
      }
    } else if (e.kind === "tool_end" || e.kind === "test_pass" || e.kind === "test_fail") {
      // Keep the pose of the call that just finished unless told otherwise.
      if (e.tool) s.tool = e.tool;
      if (e.category) s.category = e.category;
      if (e.summary) s.summary = e.summary;
    } else {
      s.tool = e.tool;
      s.category = e.category;
      s.summary = e.summary;
    }
    for (const k of ["tool", "category", "summary"] as const) if (s[k] === undefined) delete s[k];
    if (e.tokens) s.tokens += e.tokens;
    if (e.kind === "subagent_end") w.removeAt = now + this.graceMs;
    else w.removeAt = undefined;
    if (e.kind !== "idle") this.touch(w, e.ts, now);
  }

  /** Activity time is the transcript ts (so backfilled sessions age correctly), never in the future. */
  private touch(w: Worker, ts: string, now: number): void {
    const t = Date.parse(ts);
    w.lastActive = Math.max(w.lastActive, Number.isFinite(t) ? Math.min(t, now) : now);
  }

  /** Publish the ending, plus subagent_end for any interns still at their desks, and forget them. */
  private remove(w: Worker, e: RawEvent): OfficeEvent {
    const id = w.state.workerId;
    for (const child of [...this.workers.values()]) {
      if (child.state.parentId !== id) continue;
      this.workers.delete(child.state.workerId);
      if (child.removeAt === undefined) {
        this.publish({ ...this.base(child, e.ts), kind: "subagent_end" });
      }
    }
    this.workers.delete(id);
    w.state.status = e.kind;
    w.state.lastTs = e.ts;
    return this.publish(e);
  }

  private base(w: Worker, ts: string): Omit<RawEvent, "kind"> {
    const s = w.state;
    const b: Omit<RawEvent, "kind"> = { ts, agent: s.agent, workerId: s.workerId, project: s.project };
    if (s.host) b.host = s.host;
    if (s.parentId) b.parentId = s.parentId;
    if (s.cwd) b.cwd = s.cwd;
    if (s.model) b.model = s.model;
    if (s.role) b.role = s.role;
    return b;
  }

  private publish(raw: RawEvent): OfficeEvent {
    const e = { seq: ++this.seq, ...raw } as OfficeEvent;
    this.ring[this.ringHead] = e;
    this.ringHead = (this.ringHead + 1) % this.ring.length;
    this.ringSize = Math.min(this.ringSize + 1, this.ring.length);
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch {
        // A broken listener must not stop the office.
      }
    }
    return e;
  }

  /** Validate and defensively re-redact. Drops events that can't be placed. */
  private sanitize(raw: RawEvent): RawEvent | null {
    if (!raw || typeof raw !== "object") return null;
    if (!AGENTS.has(raw.agent) || !KINDS.has(raw.kind)) return null;
    const workerId = clean(raw.workerId, ID_MAX);
    if (!workerId) return null;
    const t = typeof raw.ts === "string" ? Date.parse(raw.ts) : NaN;
    const cwd = raw.cwd ? this.tilde(clean(raw.cwd, 256)) : "";
    const project = clean(raw.project, 64) || basename(cwd) || "~";

    const e: RawEvent = {
      ts: new Date(Number.isFinite(t) ? t : this.now()).toISOString(),
      agent: raw.agent,
      workerId,
      project,
      kind: raw.kind,
    };
    const host = cleanHost(raw.host);
    if (host) e.host = host;
    const parentId = clean(raw.parentId, ID_MAX);
    if (parentId && parentId !== workerId) e.parentId = parentId;
    // Remote paths are shown as they are: "~" would be this machine's home.
    if (cwd) e.cwd = host ? clean(raw.cwd, 256) : cwd;
    const model = clean(raw.model, 64);
    if (model) e.model = model;
    const tool = clean(raw.tool, 64);
    if (tool) e.tool = tool;
    if (raw.category) e.category = CATEGORIES.has(raw.category) ? raw.category : "other";
    else if (tool && !SIGNALS.has(raw.kind)) e.category = "other";
    const summary = scrub(clean(raw.summary, 200));
    if (summary) e.summary = cap(summary, SUMMARY_MAX);
    if (raw.isError === true) e.isError = true;
    if (typeof raw.tokens === "number" && Number.isFinite(raw.tokens) && raw.tokens > 0) {
      e.tokens = Math.min(Math.round(raw.tokens), 10_000_000);
    }
    const role = clean(raw.role, 48);
    if (role) e.role = role;
    return e;
  }

  private tilde(p: string): string {
    if (!this.home || !p) return p;
    if (p === this.home) return "~";
    if (p.startsWith(this.home + "/") || p.startsWith(this.home + "\\")) return "~" + p.slice(this.home.length);
    return p;
  }
}

function cleanHost(h: unknown): Host | undefined {
  if (!h || typeof h !== "object") return undefined;
  const o = h as Partial<Host>;
  if (!o.kind || !HOSTS.has(o.kind) || o.kind === "local") return undefined;
  const id = clean(o.id, 128);
  if (!id) return undefined;
  return { kind: o.kind, id, name: clean(o.name, 48) || id };
}

/** Strip control and bidi-override characters, collapse whitespace, bound length. */
function clean(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Mask anything that looks like a credential, in case upstream redaction missed it. */
function scrub(s: string): string {
  return s
    .replace(
      /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|\bgithub_pat_[A-Za-z0-9_]{8,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{10,}/g,
      "•••",
    )
    // Long opaque runs with plenty of digits and letters (tokens, keys), not long_snake_names.
    .replace(/[A-Za-z0-9+_=-]{32,}/g, (m) =>
      (m.match(/\d/g)?.length ?? 0) >= 4 && (m.match(/[A-Za-z]/g)?.length ?? 0) >= 4 ? "•••" : m,
    );
}

function cap(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : "";
}

/** "Edit router.ts" -> ["router.ts"]; "Patch a.go, b.go" -> ["a.go", "b.go"]. */
export function editedFiles(summary: string): string[] {
  const words = summary.split(/[\s,]+/).slice(1).map((w) => basename(w.replace(/^[("'`]+|[)"'`:;]+$/g, "")));
  const files = words.filter((w) => /^[\w@+.-]*\.[\w-]+$/.test(w) || /^[A-Z][\w-]*file$/.test(w));
  return files.length ? files : words.length ? [words.join(" ")] : [];
}
