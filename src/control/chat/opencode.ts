/*
 * opencode, driven over its own HTTP server: `opencode serve` in chat mode,
 * and the server inside its TUI (`opencode --port`) in terminal mode, where
 * the page's prompt box, Interrupt and Approve/Deny use the same API while
 * the TUI shows everything too. In the TUI the first answer wins: an
 * approval answered there arrives as permission.replied and closes here.
 *
 *   events  GET /event: message.updated (roles), message.part.updated /
 *           message.part.delta (text and tool parts), session.status /
 *           session.idle, session.error, permission.updated (v1) /
 *           permission.asked (v2), permission.replied, session.created and
 *           tui.session.select (which session the TUI shows)
 */
import type { Approval, ApprovalAnswer, PermissionMode } from "../../shared/control.ts";
import type { ToolCategory } from "../../shared/events.ts";
import { categorize } from "../../ingest/categories.ts";
import { shellCategory, shellSummary, toolSummary } from "../../ingest/redact.ts";
import { approvalDetail, ApprovalQueue } from "../approvals.ts";
import type { OpencodeClient, OpencodeEvent } from "../opencode-api.ts";
import { ControlError, type PipeProc } from "../types.ts";
import { APPROVAL_TEXT, approvalItem, ChatBase, endGracefully, shortReason, tailOf } from "./common.ts";

export interface OpencodeChatOptions {
  client: OpencodeClient;
  /** chat: our own `opencode serve`; tui: the server inside the TUI (no process of its own here). */
  mode: "chat" | "tui";
  proc?: PipeProc;
  where: string;
  permission: PermissionMode;
  /** Shown as "~" in an approval's detail (default: this machine's home). */
  home?: string;
  now?: () => number;
  readyTimeoutMs?: number;
}

const SHELLS = new Set(["bash", "shell"]);

/** opencode tool or permission + its input -> the office's label. */
export function opencodeLabel(tool: string, input: Record<string, any>): { category: ToolCategory; summary: string } {
  const name = tool || "tool";
  if (SHELLS.has(name)) {
    const cmd = input.command ?? "";
    return { category: shellCategory(cmd), summary: shellSummary(cmd) };
  }
  const category = categorize(name);
  return {
    category,
    summary: toolSummary(name, category, {
      file: input.filePath ?? input.file_path ?? input.filepath ?? (category === "edit" || category === "read" ? input.path : undefined),
      url: input.url,
      glob: input.pattern ?? input.include,
      path: input.path,
      subagentType: input.subagent_type,
    }),
  };
}

export class OpencodeChat extends ChatBase {
  private readonly queue = new ApprovalQueue<{ sessionId: string }>();
  private readonly stderr = tailOf();
  private readonly roles = new Map<string, string>();
  /** Text parts seen before their message's role. */
  private readonly unrouted = new Map<string, { messageId: string; text: string }>();
  private readonly texts = new Map<string, string>();
  private readonly tools = new Map<string, { tool: string; category: ToolCategory; summary: string }>();
  private readonly backlog: string[] = [];
  private stream_: { close(): void } | undefined;
  private stopping = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: OpencodeChatOptions) {
    super(o.now);
    this.queue.changed.on((a) => this.approvals.emit(a));
    if (o.proc) {
      o.proc.onStderr((d) => this.stderr.push(d));
      o.proc.onStdout(() => {});
      o.proc.onExit((e) => {
        this.stream_?.close();
        this.queue.drain();
        if (!this.stopping && this.isBusy) this.system("opencode exited.", "error");
        this.finished(e);
      });
    }
    this.ready = this.start(o.readyTimeoutMs ?? 90_000);
    this.ready.catch(() => {});
  }

  get client(): OpencodeClient {
    return this.o.client;
  }

  /** The session the page drives: ours in chat mode, the one the TUI shows in terminal mode. */
  get session(): string | undefined {
    return this.sessionId;
  }

  private async start(timeoutMs: number): Promise<void> {
    const ac = new AbortController();
    const dead = this.o.proc ? new Promise<never>((_, rej) => this.o.proc!.onExit(() => {
      ac.abort();
      rej(new Error(shortReason(this.stderr.text().trim().split("\n").pop() || "opencode exited before it was ready.")));
    })) : undefined;
    dead?.catch(() => {});
    const go = async () => {
      await this.o.client.ready(timeoutMs, ac.signal);
      this.stream_ = this.o.client.events((e) => this.onEvent(e));
      if (this.o.mode === "chat") {
        this.setSessionId(await this.o.client.createSession());
        this.system(`opencode is ready in ${this.o.where}.`);
      }
    };
    await (dead ? Promise.race([go(), dead]) : go());
  }

  async send(text: string): Promise<void> {
    await this.ready;
    if (!this.sessionId) throw new ControlError(409, "opencode has no session yet.");
    this.user(text);
    if (this.isBusy) {
      this.backlog.push(text);
      return;
    }
    await this.prompt(text);
  }

  private async prompt(text: string): Promise<void> {
    this.setBusy(true);
    try {
      await this.o.client.promptAsync(this.sessionId!, text, this.o.permission === "plan" ? "plan" : undefined);
    } catch (err) {
      this.system(shortReason((err as Error).message || "opencode refused the prompt."), "error");
      this.setBusy(false);
    }
  }

  async interrupt(): Promise<void> {
    this.backlog.length = 0;
    if (!this.sessionId) return;
    await this.o.client.abort(this.sessionId).catch(() => {});
  }

  async answer(a: ApprovalAnswer): Promise<void> {
    const p = this.queue.get(a.id);
    if (!p) throw new ControlError(409, "That approval is no longer open.");
    const response = a.decision === "allow" ? (a.always ? "always" : "once") : "reject";
    await this.o.client.replyPermission(p.meta.sessionId, a.id, response);
    if (this.queue.drop(a.id)) this.put(approvalItem(p.approval, response === "reject" ? APPROVAL_TEXT.denied : response === "always" ? APPROVAL_TEXT.always : APPROVAL_TEXT.allowed));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stream_?.close();
    if (this.o.proc) await endGracefully(this.o.proc, { endStdin: false, termAfterMs: 3000, killAfterMs: 1 });
  }

  /** Terminal mode: stop listening (the TUI's own exit ends the session). */
  close(): void {
    this.stream_?.close();
    this.queue.drain();
  }

  private ours(sessionId: unknown): boolean {
    return typeof sessionId === "string" && sessionId === this.sessionId;
  }

  private onEvent(e: OpencodeEvent): void {
    const p = e.properties ?? {};
    switch (e.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info ?? {};
        // The TUI's session: the newest top-level one (subagents have a parent).
        if (this.o.mode === "tui" && e.type === "session.created" && typeof info.id === "string" && !info.parentID) this.setSessionId(info.id);
        return;
      }
      case "tui.session.select":
        if (this.o.mode === "tui" && typeof p.sessionID === "string") this.setSessionId(p.sessionID);
        return;
      case "message.updated": {
        const info = p.info ?? {};
        if (typeof info.id !== "string" || typeof info.role !== "string") return;
        this.roles.set(info.id, info.role);
        if (this.roles.size > 500) this.roles.delete(this.roles.keys().next().value!);
        for (const [partId, u] of this.unrouted) {
          if (u.messageId !== info.id) continue;
          this.unrouted.delete(partId);
          if (info.role === "assistant") this.text(partId, u.text, true);
        }
        return;
      }
      case "message.part.updated": {
        const part = p.part ?? {};
        if (!this.ours(part.sessionID) || typeof part.id !== "string") return;
        if (part.type === "text" && typeof part.text === "string") {
          const role = this.roles.get(part.messageID);
          if (role === "user" || part.synthetic) return;
          if (role === "assistant") this.text(part.id, part.text, !!part.time?.end);
          else this.unrouted.set(part.id, { messageId: part.messageID, text: part.text });
          return;
        }
        if (part.type === "tool") this.tool(part);
        return;
      }
      case "message.part.delta": {
        if (!this.ours(p.sessionID) || typeof p.partID !== "string" || p.field !== "text" || typeof p.delta !== "string") return;
        const id = `p-${p.partID}`;
        if (this.roles.get(p.messageID) !== "assistant") return;
        this.text(p.partID, (this.texts.get(id) ?? "") + p.delta, false);
        return;
      }
      case "session.status":
        if (!this.ours(p.sessionID)) return;
        if (p.status?.type === "busy") this.setBusy(true);
        else if (p.status?.type === "idle") this.idle();
        return;
      case "session.idle":
        if (this.ours(p.sessionID)) this.idle();
        return;
      case "session.error": {
        if (p.sessionID && !this.ours(p.sessionID)) return;
        const name = p.error?.name;
        if (name === "MessageAbortedError") this.system("Interrupted.");
        else this.system(shortReason(p.error?.data?.message || name || "opencode reported an error."), "error");
        return;
      }
      case "permission.updated":
      case "permission.asked":
        return this.ask(p);
      case "permission.replied": {
        const id = p.permissionID ?? p.requestID;
        if (typeof id !== "string") return;
        const gone = this.queue.drop(id);
        if (gone) this.put(approvalItem(gone.approval, p.response === "reject" || p.reply === "reject" ? APPROVAL_TEXT.denied : APPROVAL_TEXT.withdrawn));
        return;
      }
      default:
        return;
    }
  }

  private text(partId: string, text: string, final: boolean): void {
    const id = `p-${partId}`;
    this.texts.set(id, text);
    if (this.texts.size > 200) this.texts.delete(this.texts.keys().next().value!);
    if (!text.trim()) return;
    const item = { id, kind: "assistant" as const, text, at: this.iso() };
    if (final) this.put(item);
    else this.stream(item);
  }

  private tool(part: any): void {
    const id = `t-${part.callID ?? part.id}`;
    const st = part.state ?? {};
    let label = this.tools.get(id);
    if (!label || (st.input && Object.keys(st.input).length)) {
      const tool = typeof part.tool === "string" ? part.tool : "tool";
      label = { tool, ...opencodeLabel(tool, st.input ?? {}) };
      this.tools.set(id, label);
      if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value!);
    }
    const status = st.status === "completed" ? "ok" : st.status === "error" ? "error" : "running";
    this.put({ id, kind: "tool", ...label, status, at: this.iso() });
    if (status !== "running") this.tools.delete(id);
  }

  private ask(p: any): void {
    if (typeof p.id !== "string" || typeof p.sessionID !== "string") return;
    const tool = String(p.type ?? p.permission ?? "tool");
    const patterns: string[] = Array.isArray(p.patterns) ? p.patterns : Array.isArray(p.pattern) ? p.pattern : typeof p.pattern === "string" ? [p.pattern] : [];
    const meta = p.metadata ?? {};
    const input = SHELLS.has(tool) ? { command: meta.command ?? patterns[0] ?? "" } : { filePath: meta.filepath ?? meta.filePath ?? meta.path ?? patterns[0], url: meta.url };
    const { category, summary } = opencodeLabel(tool, input);
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const detail = approvalDetail(
      SHELLS.has(tool)
        ? [str(meta.command) ?? patterns.join("\n")]
        : [str(meta.filepath) ?? str(meta.filePath) ?? str(meta.path), str(meta.url), str(meta.diff), !meta.diff && !meta.filepath && !meta.filePath && !meta.path ? patterns.join("\n") : undefined],
      this.o.home,
    );
    const approval: Approval = { id: p.id, tool, category, summary, ...(detail ? { detail } : {}), at: this.iso() };
    if (this.o.mode === "chat" && this.o.permission === "bypass") {
      // Bypass in chat mode: serve has no --auto, so the office says yes to each request itself.
      void this.o.client.replyPermission(p.sessionID, p.id, "once").catch(() => {});
      return;
    }
    if (this.queue.get(p.id)) return;
    this.queue.add(approval, { sessionId: p.sessionID });
    this.put(approvalItem(approval, APPROVAL_TEXT.open));
  }

  private idle(): void {
    if (!this.isBusy) return;
    for (const [id, t] of this.tools) this.put({ id, kind: "tool", ...t, status: "error", at: this.iso() });
    this.tools.clear();
    this.setBusy(false);
    const t = this.backlog.shift();
    if (t !== undefined) void this.prompt(t);
  }
}
