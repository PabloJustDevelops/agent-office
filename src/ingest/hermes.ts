/*
 * Hermes Agent keeps everything in one SQLite file, $HERMES_HOME/state.db
 * (default ~/.hermes/state.db): session rows (parent_session_id set for
 * subagent sessions), and message rows whose role is user, assistant or tool.
 * An assistant row's tool_calls JSON lists the calls it issued; a tool row
 * answers one of them by tool_call_id. The SQL pulls only the handful of
 * fields a label needs (never prompt text or file contents; a terminal
 * output tail only to judge test runs), and is shaped like opencode's so the
 * parser can diff each poll against what it has already seen.
 */
import type { RawEvent, ToolCategory } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import { emit, exitCode, isObj, newCtx, setCwd, toolFields, type ParserState, type PendingTool, type WorkerCtx } from "./common.ts";
import { isTestCommand, mcpSummary, outputLooksFailed, shellCategory, shellSummary, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface HmSession {
  id: string;
  parent_session_id?: string | null;
  profile_name?: string | null;
  cwd?: string | null;
  model?: string | null;
  started_at?: number | null;
  last_activity_at: number;
  ended_at?: number | null;
  title?: string | null;
}

export interface HmMessage {
  id: string;
  session_id: string;
  timestamp: number;
  role?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  tool_calls?: string | null;
  text_len?: number | null;
  out?: string | null;
}

interface MsgSeen {
  prompted: boolean;
  done: boolean;
  closed: boolean;
}

export interface HermesState extends ParserState {
  msgs: Map<string, MsgSeen>;
  /** Tool call id -> "" once its call has been seen (deduped across polls). */
  parts: Map<string, string>;
}

export function createHermesState(s: HmSession): HermesState {
  const main = newCtx("hermes", s.id, s.parent_session_id ? { parentId: s.parent_session_id, role: s.profile_name || "subagent" } : {});
  if (s.cwd) setCwd(main, s.cwd);
  if (s.model) main.model = s.model;
  return { main, workers: new Map([[main.workerId, main]]), msgs: new Map(), parts: new Map() };
}

/** Hermes stamps epoch seconds, float. */
const iso = (sec: unknown) => new Date(typeof sec === "number" && Number.isFinite(sec) ? sec * 1000 : Date.now()).toISOString();

function trim<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) m.delete(m.keys().next().value!);
}

/** Fold one poll's rows for a session in; returns only what changed since the last poll. */
export function applyHermes(state: HermesState, messages: HmMessage[]): RawEvent[] {
  const ctx = state.main;
  const out: RawEvent[] = [];
  const msgs = [...messages].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : 1));
  for (const m of msgs) {
    let ms = state.msgs.get(m.id);
    if (!ms) {
      state.msgs.set(m.id, (ms = { prompted: false, done: false, closed: false }));
      trim(state.msgs, 400);
    }
    if (m.role === "user") {
      if (ms.prompted) continue;
      if ((m.text_len ?? 0) > 0) {
        ms.prompted = true;
        ctx.pending.clear();
        out.push(...emit(ctx, "prompt", iso(m.timestamp), { summary: "New prompt" }));
      }
      continue;
    }
    if (m.role === "tool") {
      if (ms.closed) continue;
      ms.closed = true;
      out.push(...closed(ctx, m));
      continue;
    }
    if (m.role !== "assistant") continue;
    const calls = parseCalls(m.tool_calls);
    if (calls.length) {
      for (const c of calls) out.push(...call(state, ctx, c, m.timestamp));
      continue;
    }
    if ((m.text_len ?? 0) > 0 && !ms.done) {
      ms.done = true;
      const ts = iso(m.timestamp);
      ctx.pending.clear();
      out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
      out.push(...(ctx.parentId ? emit(ctx, "subagent_end", ts) : emit(ctx, "waiting", ts, { summary: "Waiting" })));
    }
  }
  return out;
}

interface HmCall {
  id: string;
  callId?: string;
  name: string;
  args: Record<string, any> | null;
}

function call(state: HermesState, ctx: WorkerCtx, c: HmCall, sec: number): RawEvent[] {
  if (state.parts.has(c.id) || (c.callId !== undefined && state.parts.has(c.callId))) return [];
  state.parts.set(c.id, "");
  if (c.callId) state.parts.set(c.callId, "");
  trim(state.parts, 2_000);
  const pend = pendingFor(c.name, c.args);
  ctx.pending.set(c.id, pend);
  if (c.callId) ctx.pending.set(c.callId, pend);
  return emit(ctx, "tool_start", iso(sec), toolFields(pend));
}

/** A tool row answered a call: close it, and score a test run from its output tail. */
function closed(ctx: WorkerCtx, m: HmMessage): RawEvent[] {
  const id = m.tool_call_id;
  if (!id) return [];
  const pend = ctx.pending.get(id);
  if (!pend) return [];
  for (const [k, v] of ctx.pending) if (v === pend) ctx.pending.delete(k);
  const ts = iso(m.timestamp);
  const text = m.out ?? "";
  const exit = m.out !== null && m.out !== undefined ? exitCode(text) : undefined;
  const failedOut = text ? outputLooksFailed(text) : false;
  const isError = exit !== undefined ? exit !== 0 : failedOut;
  const out: RawEvent[] = [];
  out.push(...emit(ctx, "tool_end", ts, { ...toolFields(pend), ...(isError ? { isError: true } : {}) }));
  if (pend.test) {
    const failed = isError || (!!pend.piped && failedOut);
    const verdict = testVerdict(pend, failed, text);
    if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(pend), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  }
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function pendingFor(name: string, args: Record<string, any> | null): PendingTool {
  const a = args ?? {};
  if (name === "terminal") {
    const cmd = a.command;
    const pend: PendingTool = { tool: name, category: shellCategory(cmd), summary: shellSummary(cmd), test: false };
    if (isTestCommand(cmd)) {
      pend.test = true;
      pend.piped = testExitHidden(cmd);
      pend.guarded = testGuarded(cmd);
    }
    return pend;
  }
  if (name.startsWith("mcp__")) return { tool: name, category: "mcp", summary: mcpSummary(name), test: false };
  const category: ToolCategory = categorize(name);
  const summary = toolSummary(name, category, {
    file: str(a.file_path) ?? str(a.path),
    files: Array.isArray(a.files) ? a.files : undefined,
    path: str(a.path),
    glob: str(a.pattern),
    url: str(a.url),
  });
  return { tool: name, category, summary, test: false };
}

/* ---------------------------------------------------------- tool calls */

function parseArgs(v: unknown): Record<string, any> | null {
  if (isObj(v)) return v;
  if (typeof v !== "string" || !v.trim()) return null;
  try {
    const o = JSON.parse(v);
    return isObj(o) ? o : null;
  } catch {
    return null;
  }
}

function toCall(v: unknown): HmCall | null {
  if (!isObj(v) || !isObj(v.function)) return null;
  const fn = v.function;
  const name = typeof fn.name === "string" ? fn.name : "";
  if (!name) return null;
  const id = typeof v.id === "string" && v.id ? v.id : typeof v.call_id === "string" && v.call_id ? v.call_id : "";
  if (!id) return null;
  return {
    id,
    ...(typeof v.call_id === "string" && v.call_id ? { callId: v.call_id } : {}),
    name,
    args: parseArgs(fn.arguments),
  };
}

/** The tool_calls column is capped at 2000 chars, so a long list can end mid-object. */
export function parseCalls(raw: string | null | undefined): HmCall[] {
  const text = raw?.trim();
  if (!text || text[0] !== "[") return [];
  try {
    const v: unknown = JSON.parse(text);
    if (Array.isArray(v)) return v.map(toCall).filter((c): c is HmCall => !!c);
  } catch {
    // Truncated: pull out the whole calls below.
  }
  const out: HmCall[] = [];
  const re = /"id"\s*:\s*"([^"]+)"[\s\S]*?"name"\s*:\s*"([^"]+)"(?:\s*,\s*"arguments"\s*:\s*"((?:[^"\\]|\\.)*)")?/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let args: Record<string, any> | null = null;
    if (m[3] !== undefined) {
      try {
        args = parseArgs(JSON.parse(`"${m[3]}"`));
      } catch {
        args = null;
      }
    }
    out.push({ id: m[1]!, name: m[2]!, args });
  }
  return out;
}

/* ------------------------------------------------------------------- SQL */

/** Column sets vary by Hermes version; only ask for what exists. */
export function hmSessionSql(cols: Set<string>, where: "updated" | "id"): string {
  const col = (n: string) => (cols.has(n) ? n : `null as ${n}`);
  const alive = `${cols.has("archived") ? " and coalesce(archived,0)=0" : ""}${cols.has("hidden") ? " and coalesce(hidden,0)=0" : ""}`;
  const sel = `id, ${col("parent_session_id")}, ${col("profile_name")}, ${col("cwd")}, ${col("model")}, ${col("started_at")}, last_activity_at, ${col("ended_at")}, ${col("title")}`;
  return where === "updated"
    ? `select ${sel} from sessions where last_activity_at > ?${alive} order by last_activity_at limit 200`
    : `select ${sel} from sessions where id = ?`;
}

const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * One row's tool_calls, rebuilt in SQL: every call, with only the argument fields a label needs, each
 * capped on its own. Cutting the serialized array instead loses every call after a big one (a patch with
 * a long diff) and, worse, leaves one call's arguments unparseable, so a patch stops naming its file and
 * a terminal stops being recognised as a test.
 */
const A = `json_extract(value, '$.function.arguments')`;
const CALLS = `case when json_valid(m.tool_calls) then
(select json_group_array(json_object('id', json_extract(value, '$.id'), 'call_id', json_extract(value, '$.call_id'),
'function', json_object('name', json_extract(value, '$.function.name'), 'arguments', json_object(
'command', substr(json_extract(${A}, '$.command'), 1, 4000),
'file_path', json_extract(${A}, '$.file_path'), 'path', json_extract(${A}, '$.path'),
'pattern', json_extract(${A}, '$.pattern'), 'url', json_extract(${A}, '$.url')))))
from json_each(m.tool_calls)) end`;

const MSG_COLS = `m.id as id, m.session_id as session_id, m.timestamp as timestamp, m.role as role,
m.tool_name as tool_name, m.tool_call_id as tool_call_id, ${CALLS} as tool_calls,
case when m.role = 'tool' and m.tool_name = 'terminal' then substr(m.content, -20000) end as out,
case when m.role <> 'tool' then length(m.content) end as text_len`;

/** The latest `limit` messages of each session (the (session_id, timestamp, id) index does the work). */
export function hmMessagesSql(sessions: number): string {
  return `with r as (select id, row_number() over (partition by session_id order by timestamp desc, id desc) as rn from messages where session_id in (${ph(sessions)}))
select ${MSG_COLS}
from messages m join r on r.id = m.id where r.rn <= ?`;
}

/**
 * Everything written to one session after a row id. A live poll must not fall back to "the last N
 * messages": between two polls Hermes can write more than N rows, and the assistant row that issued a
 * tool call would fall outside the window, leaving its result with nothing to close (the call is
 * dropped, a failed test included). ids are rowids, so `>` walks forward.
 */
export function hmMessagesAfterSql(): string {
  return `select ${MSG_COLS} from messages m where m.session_id = ? and m.id > ? order by m.id limit ?`;
}

/** Rows come back loosely typed (and from a remote's sqlite3 CLI); keep only well-formed ones. */
export function asHermesSession(r: Record<string, unknown>): HmSession | null {
  if (typeof r.id !== "string" || typeof r.last_activity_at !== "number") return null;
  return r as unknown as HmSession;
}
export function asHermesMessage(r: Record<string, unknown>): HmMessage | null {
  // `messages.id` is an INTEGER in Hermes' schema (sessions.id is TEXT), so accept both and keep a
  // zero-padded string: applyHermes sorts ties by id, and "999" must not sort after "1000".
  if (typeof r.id !== "number" && typeof r.id !== "string") return null;
  if (typeof r.session_id !== "string" || typeof r.timestamp !== "number") return null;
  return { ...r, id: String(r.id).padStart(12, "0") } as unknown as HmMessage;
}
