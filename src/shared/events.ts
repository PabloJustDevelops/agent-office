/*
 * The one shape every part of agent office agrees on. Ingest turns transcript
 * lines into OfficeEvents, the server streams them over SSE, the web client
 * folds them into the scene. Nothing here carries raw transcript content:
 * `summary` is a short, already-redacted label like "Edit cli.ts" or
 * "$ npm test", capped at SUMMARY_MAX characters.
 */

export type AgentKind = "claude" | "commandcode" | "codex";

export type ToolCategory =
  | "read"    // Read, read_file, cat-like tools
  | "edit"    // Edit, Write, MultiEdit, apply_patch, write_file, NotebookEdit
  | "bash"    // Bash, shell, exec_command, run_command
  | "search"  // Grep, Glob, search, find, ls
  | "web"     // WebFetch, WebSearch, browser tools
  | "agent"   // Task / Agent / spawning a subagent
  | "todo"    // TodoWrite, plan updates
  | "mcp"     // any mcp__* tool
  | "other";

export type EventKind =
  | "session_start"  // first sighting of a session (also sent on backfill)
  | "prompt"         // the human sent a message
  | "thinking"       // model is reasoning / generating
  | "tool_start"     // a tool call was issued
  | "tool_end"       // its result came back (isError set if it failed)
  | "reply"          // assistant text addressed to the human
  | "waiting"        // turn finished, agent is waiting on the human
  | "test_fail"      // a test command exited non-zero  -> table flip
  | "test_pass"      // a test command passed           -> celebration
  | "error"          // API error, interrupted turn, crashed tool
  | "subagent_start" // a subagent of this session appeared
  | "subagent_end"   // that subagent finished
  | "idle"           // no activity for IDLE_MS
  | "session_end";   // no activity for GONE_MS, remove from the office

export interface OfficeEvent {
  /** Monotonic per-server id, assigned by the server. */
  seq: number;
  /** ISO timestamp from the transcript line (or now, for synthetic events). */
  ts: string;
  agent: AgentKind;
  /** Stable id of the worker: the session id, or the subagent id for subagents. */
  workerId: string;
  /** For subagents: the workerId of the parent session. */
  parentId?: string;
  /** Project label, the basename of cwd. */
  project: string;
  /** Full cwd, shown only in the inspector. */
  cwd?: string;
  model?: string;
  kind: EventKind;
  tool?: string;
  category?: ToolCategory;
  /** Short redacted label, <= SUMMARY_MAX chars. */
  summary?: string;
  isError?: boolean;
  /** Tokens this line reported (input + output), when the transcript has it. */
  tokens?: number;
  /** Subagent role / description, e.g. "Explore", "general-purpose". */
  role?: string;
}

/** What the server sends on connect: the current office, then live events. */
export interface Snapshot {
  version: 1;
  startedAt: string;
  demo: boolean;
  workers: WorkerState[];
  recent: OfficeEvent[]; // last <= 200 events, oldest first
}

export interface WorkerState {
  workerId: string;
  parentId?: string;
  agent: AgentKind;
  project: string;
  cwd?: string;
  model?: string;
  role?: string;
  /** Last event kind and its tool, so a fresh client can pose the sprite. */
  status: EventKind;
  tool?: string;
  category?: ToolCategory;
  summary?: string;
  lastTs: string;
  toolCalls: number;
  tokens: number;
  filesTouched: number;
}

export const SUMMARY_MAX = 64;
/** Quiet this long -> idle. */
export const IDLE_MS = 90_000;
/** Quiet this long -> leaves the office. */
export const GONE_MS = 20 * 60_000;
/** On startup, sessions touched within this window are backfilled. */
export const ACTIVE_WINDOW_MS = 30 * 60_000;

/* Wire format.  GET /events is text/event-stream:
 *   event: snapshot   data: Snapshot      (once, on connect)
 *   event: office     data: OfficeEvent   (every live event)
 *   : ping                                (every 15s)
 * GET /api/snapshot returns the Snapshot as JSON.
 * GET / serves the web app; GET /assets/* serves dist/web/assets.
 */

export const BRAND: Record<AgentKind, { name: string; color: string; ink: string }> = {
  claude: { name: "Claude Code", color: "#D97757", ink: "#1F1E1D" },
  commandcode: { name: "Command Code", color: "#F2F2F2", ink: "#0A0A0A" },
  codex: { name: "Codex", color: "#10A37F", ink: "#0B0F0E" },
};

/* Ingest -> server seam. Implemented in src/ingest/index.ts. */
export type RawEvent = Omit<OfficeEvent, "seq">;

export interface IngestOptions {
  agents: AgentKind[];
  onEvent: (e: RawEvent) => void;
  log?: (msg: string) => void;
}

export type StartIngest = (opts: IngestOptions) => { stop(): void };
