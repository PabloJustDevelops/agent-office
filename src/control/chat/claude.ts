/*
 * Claude Code in chat mode: `claude -p --input-format stream-json
 * --output-format stream-json --verbose --include-partial-messages
 * --permission-prompt-tool stdio`, one long-lived process, one JSON object per
 * line each way (the Agent SDK's protocol).
 *
 *   in:  control_request initialize / interrupt, user turns, control_response
 *        answers to can_use_tool
 *   out: stream_event deltas, assistant / user messages, result per turn,
 *        control_request can_use_tool, control_cancel_request
 *
 * Claude queues turns itself, so a prompt is written at once even mid-turn.
 * After an interrupted last turn the process exits 1 when stdin closes; that
 * is reported as is, not as a failure.
 */
import type { ApprovalAnswer } from "../../shared/control.ts";
import type { ToolCategory } from "../../shared/events.ts";
import { ApprovalQueue, claudeToolDetail, claudeToolLabel, DENY_MESSAGE, sessionPermissions } from "../approvals.ts";
import type { PipeProc } from "../types.ts";
import { APPROVAL_TEXT, approvalItem, ChatBase, endGracefully, jsonLines, shortReason, tailOf } from "./common.ts";

interface Ask {
  requestId: string;
  toolUseId?: string;
  toolName: string;
  /** Claude's own session rules for "always"; null: no "always" for this ask. */
  always: unknown[] | null;
}

export interface ClaudeChatOptions {
  proc: PipeProc;
  /** The pinned --session-id. */
  sessionId: string;
  /** "~/x" for the ready line. */
  where: string;
  /** Shown as "~" in an approval's detail (default: this machine's home; "" for none, on a remote). */
  home?: string;
  now?: () => number;
  /** How long the initialize handshake may take. */
  readyTimeoutMs?: number;
}

const RESULT_ERRORS: Record<string, string> = {
  error_max_turns: "Stopped: it hit the turn limit.",
  error_max_budget_usd: "Stopped: it hit the budget limit.",
  error_during_execution: "The turn failed.",
};

export class ClaudeChat extends ChatBase {
  private readonly proc: PipeProc;
  private readonly queue = new ApprovalQueue<Ask>();
  private readonly stderr = tailOf();
  private reqSeq = 0;
  private pendingTurns = 0;
  private interruptedAt = 0;
  private msgTexts = new Map<string, number>();
  /** stream index -> text ordinal, per message id. */
  private streamText = new Map<string, Map<number, number>>();
  private assistantTexts = new Map<string, number>();
  private texts = new Map<string, string>();
  private tools = new Map<string, { tool: string; category: ToolCategory; summary: string }>();
  private currentMsg: string | undefined;
  private stopping = false;
  readonly ready: Promise<void>;

  constructor(private readonly o: ClaudeChatOptions) {
    super(o.now);
    this.proc = o.proc;
    this.sessionId = o.sessionId;
    this.queue.changed.on((a) => this.approvals.emit(a));
    let ok!: () => void, fail!: (e: Error) => void;
    this.ready = new Promise<void>((res, rej) => ((ok = res), (fail = rej)));
    this.ready.catch(() => {});
    const timer = setTimeout(() => fail(new Error("Claude Code didn't answer its handshake.")), o.readyTimeoutMs ?? 60_000);
    this.onReady = (err) => {
      clearTimeout(timer);
      if (err) fail(err);
      else {
        ok();
        this.system(`Claude Code is ready in ${o.where}.`);
      }
    };
    this.proc.onStdout(jsonLines((m) => this.onMessage(m)));
    this.proc.onStderr((d) => this.stderr.push(d));
    this.proc.onExit((e) => {
      clearTimeout(timer);
      this.onReady?.(new Error(shortReason(this.stderr.text().trim().split("\n").pop() || `Claude Code exited (${e.code ?? "signal"}).`)));
      this.queue.drain();
      if (!this.stopping && this.pendingTurns) this.system("Claude Code exited.", "error");
      this.finished(e);
    });
    this.write({ type: "control_request", request_id: "init", request: { subtype: "initialize" } });
  }

  private onReady: ((err?: Error) => void) | undefined;

  private write(o: unknown): void {
    this.proc.write(JSON.stringify(o) + "\n");
  }

  async send(text: string): Promise<void> {
    this.user(text);
    this.pendingTurns++;
    this.setBusy(true);
    this.write({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: this.sessionId });
  }

  async interrupt(): Promise<void> {
    if (!this.isBusy) return;
    this.interruptedAt = this.now();
    for (const p of this.queue.drain()) {
      this.respond(p.meta, { behavior: "deny", message: "Interrupted from agent office", interrupt: true, toolUseID: p.meta.toolUseId });
      this.put(approvalItem(p.approval, APPROVAL_TEXT.interrupted));
    }
    this.write({ type: "control_request", request_id: `int-${++this.reqSeq}`, request: { subtype: "interrupt" } });
  }

  async answer(a: ApprovalAnswer): Promise<void> {
    const p = this.queue.take(a.id);
    const m = p.meta;
    const allow = a.decision === "allow";
    this.respond(
      m,
      allow
        ? { behavior: "allow", toolUseID: m.toolUseId, ...(a.always && m.always ? { updatedPermissions: m.always } : {}) }
        : { behavior: "deny", message: DENY_MESSAGE, toolUseID: m.toolUseId },
    );
    this.put(approvalItem(p.approval, allow ? (a.always && m.always ? APPROVAL_TEXT.always : APPROVAL_TEXT.allowed) : APPROVAL_TEXT.denied));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await endGracefully(this.proc, { endStdin: true, termAfterMs: 5000, killAfterMs: 3000 });
  }

  private respond(m: Ask, response: Record<string, unknown>): void {
    this.write({ type: "control_response", response: { subtype: "success", request_id: m.requestId, response } });
  }

  private onMessage(m: any): void {
    switch (m.type) {
      case "control_response": {
        const r = m.response ?? {};
        if (r.request_id === "init") {
          if (r.subtype === "success") this.onReady?.();
          else this.onReady?.(new Error(shortReason(r.error || "Claude Code refused the handshake.")));
          this.onReady = undefined;
        }
        return;
      }
      case "control_request":
        if (m.request?.subtype === "can_use_tool") this.ask(m);
        else if (typeof m.request_id === "string") {
          // Anything else Claude asks the client (hook callbacks, MCP messages) has no answer here.
          this.write({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: "Not supported by agent office" } });
        }
        return;
      case "control_cancel_request":
        if (typeof m.request_id === "string") {
          const p = this.queue.drop(m.request_id);
          if (p) this.put(approvalItem(p.approval, APPROVAL_TEXT.withdrawn));
        }
        return;
      case "stream_event":
        if (m.parent_tool_use_id) return;
        return this.onStream(m.event ?? {});
      case "assistant":
        if (m.parent_tool_use_id) return;
        return this.onAssistant(m.message ?? {});
      case "user":
        if (m.isReplay || m.parent_tool_use_id) return;
        return this.onToolResults(m.message?.content);
      case "result":
        return this.onResult(m);
      default:
        return;
    }
  }

  private ask(m: any): void {
    const r = m.request ?? {};
    const toolName = typeof r.tool_name === "string" ? r.tool_name : "tool";
    const { category, summary } = claudeToolLabel(toolName, r.input);
    const detail = claudeToolDetail(toolName, r.input, { reason: r.decision_reason, description: r.description, blockedPath: r.blocked_path }, this.o.home);
    const always = sessionPermissions(r.permission_suggestions, r.suppress_always_allow_rule);
    const approval = { id: String(m.request_id), tool: toolName, category, summary, ...(detail ? { detail } : {}), ...(always ? {} : { noAlways: true }), at: this.iso() };
    this.queue.add(approval, { requestId: String(m.request_id), toolUseId: r.tool_use_id, toolName, always });
    this.put(approvalItem(approval, APPROVAL_TEXT.open));
  }

  private textId(msgId: string, ordinal: number): string {
    return `a-${msgId}-${ordinal}`;
  }

  private onStream(e: any): void {
    if (e.type === "message_start") {
      this.currentMsg = typeof e.message?.id === "string" ? e.message.id : undefined;
      return;
    }
    const msg = this.currentMsg;
    if (!msg) return;
    if (e.type === "content_block_start" && e.content_block?.type === "text") {
      const n = this.msgTexts.get(msg) ?? 0;
      this.msgTexts.set(msg, n + 1);
      let map = this.streamText.get(msg);
      if (!map) this.streamText.set(msg, (map = new Map()));
      map.set(e.index, n);
      if (this.streamText.size > 64) this.streamText.delete(this.streamText.keys().next().value!);
      return;
    }
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
      const n = this.streamText.get(msg)?.get(e.index);
      if (n === undefined) return;
      const id = this.textId(msg, n);
      const text = (this.texts.get(id) ?? "") + e.delta.text;
      this.texts.set(id, text);
      this.stream({ id, kind: "assistant", text, at: this.iso() });
    }
  }

  private onAssistant(msg: any): void {
    const msgId = typeof msg.id === "string" ? msg.id : this.nextId("m");
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === "text" && typeof b.text === "string") {
        const n = this.assistantTexts.get(msgId) ?? 0;
        this.assistantTexts.set(msgId, n + 1);
        if (this.assistantTexts.size > 64) this.assistantTexts.delete(this.assistantTexts.keys().next().value!);
        const id = this.textId(msgId, n);
        this.texts.delete(id);
        if (b.text.trim()) this.put({ id, kind: "assistant", text: b.text, at: this.iso() });
      } else if (b?.type === "tool_use" && typeof b.id === "string") {
        const tool = typeof b.name === "string" ? b.name : "tool";
        const { category, summary } = claudeToolLabel(tool, b.input);
        this.tools.set(b.id, { tool, category, summary });
        if (this.tools.size > 500) this.tools.delete(this.tools.keys().next().value!);
        this.put({ id: `t-${b.id}`, kind: "tool", tool, category, summary, status: "running", at: this.iso() });
      }
    }
  }

  private onToolResults(content: unknown): void {
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type !== "tool_result" || typeof b.tool_use_id !== "string") continue;
      const t = this.tools.get(b.tool_use_id);
      if (!t) continue;
      this.tools.delete(b.tool_use_id);
      this.put({ id: `t-${b.tool_use_id}`, kind: "tool", ...t, status: b.is_error ? "error" : "ok", at: this.iso() });
    }
  }

  private onResult(m: any): void {
    this.pendingTurns = Math.max(0, this.pendingTurns - 1);
    const interrupted = this.interruptedAt && this.now() - this.interruptedAt < 60_000;
    if (m.subtype !== "success" || m.is_error) {
      if (interrupted && (m.subtype === "error_during_execution" || m.subtype === "success")) {
        this.interruptedAt = 0;
        this.system("Interrupted.");
      } else {
        const reason = RESULT_ERRORS[m.subtype] ?? (typeof m.result === "string" && m.result ? shortReason(m.result) : "The turn failed.");
        this.system(reason, "error");
      }
    } else if (interrupted) this.interruptedAt = 0;
    // Tools that never got a result (interrupted mid-call) stop spinning.
    if (!this.pendingTurns) {
      for (const [id, t] of this.tools) this.put({ id: `t-${id}`, kind: "tool", ...t, status: "error", at: this.iso() });
      this.tools.clear();
      this.setBusy(false);
    }
  }
}
