// Tests for the per-agent transcript parsers (src/ingest/claude.ts, commandcode.ts, codex.ts) on synthetic fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FX = join(ROOT, "test", "fixtures");

async function load(...entries) {
  const dir = mkdtempSync(join(tmpdir(), "agentoffice-test-"));
  const outfile = join(dir, "mod.mjs");
  await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(`./${e}`)};`).join("\n"), resolveDir: ROOT, loader: "ts" },
    bundle: true, platform: "node", format: "esm", target: "node18", outfile, logLevel: "error",
  });
  try {
    return await import(pathToFileURL(outfile).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const P = await load("src/ingest/claude.ts", "src/ingest/commandcode.ts", "src/ingest/codex.ts", "src/shared/events.ts");

const CLAUDE_SID = "11111111-2222-4333-8444-555555555555";
const CLAUDE_MAIN = `claude/projects/-tmp-demo-app/${CLAUDE_SID}.jsonl`;
const CLAUDE_SUB = `claude/projects/-tmp-demo-app/${CLAUDE_SID}/subagents/agent-a1b2c3d4e5f6a7b8c.jsonl`;
const CC_V3 = "commandcode/projects/tmp-demo-app/aB3dE5gH7jK9mN1pQ3sT5.jsonl";
const CC_LEGACY = "commandcode/projects/tmp-demo-app/legacy-0001.jsonl";
const CODEX_ID = "019a0000-1111-7222-8333-444455556666";
const CODEX_SUB_ID = "019a0000-9999-7aaa-8bbb-ccccddddeeee";
const CODEX_MAIN = `codex/sessions/2026/01/15/rollout-2026-01-15T10-00-00-${CODEX_ID}.jsonl`;
const CODEX_SUB = `codex/sessions/2026/01/15/rollout-2026-01-15T10-00-12-${CODEX_SUB_ID}.jsonl`;

function run(state, parse, rel) {
  const out = [];
  for (const line of readFileSync(join(FX, rel), "utf8").split("\n")) out.push(...parse(state, line));
  return out;
}

const kinds = (evs) => evs.map((e) => e.kind);
const pick = (evs, kind) => evs.filter((e) => e.kind === kind);

/** Nothing from a prompt, reply, file body, regex or command argument may appear anywhere in an event. */
function assertPrivate(evs) {
  const blob = JSON.stringify(evs);
  for (const leak of [/secret/i, /password/, /ghp_/, /sk-ant/, /nocapture/, /SECRET_NEEDLE/]) assert.doesNotMatch(blob, leak);
  for (const e of evs) {
    if (e.summary) assert.ok([...e.summary].length <= P.SUMMARY_MAX, e.summary);
    if (e.kind === "prompt") assert.equal(e.summary, "New prompt");
    if (e.kind === "reply") assert.equal(e.summary, "Replied");
  }
}

test("claude: a full session", () => {
  const evs = run(P.createClaudeState({ sessionId: CLAUDE_SID }), P.parseClaudeLine, CLAUDE_MAIN);
  assertPrivate(evs);
  assert.deepEqual(kinds(evs), [
    "session_start", "prompt", "thinking",
    "tool_start", "tool_end", "test_fail", // npm test, is_error + "Exit code 1"
    "tool_start", "tool_end", // Edit
    "tool_start", "tool_end", "test_pass", // CI=1 npm test
    "tool_start", "tool_end", // Agent
    "reply", "waiting", // end_turn; turn_duration adds nothing more
    "prompt", // caveat, slash command and the broken line are skipped
    "tool_start", "tool_end", "tool_start", "tool_end", "tool_start", "tool_end", "tool_start", "tool_end",
    "tool_end", // a result for a call we never saw
    "error", "error", // interrupt, API error
  ]);
  for (const e of evs) {
    assert.equal(e.agent, "claude");
    assert.equal(e.workerId, CLAUDE_SID);
    assert.equal(e.project, "demo-app");
    assert.equal(e.parentId, undefined);
  }
  const starts = pick(evs, "tool_start");
  assert.deepEqual(starts.map((e) => [e.tool, e.category, e.summary]), [
    ["Bash", "bash", "$ npm test"],
    ["Edit", "edit", "Edit cli.ts"],
    ["Bash", "bash", "$ npm test"],
    ["Agent", "agent", "Spawn Explore"],
    ["WebFetch", "web", "Fetch docs.example.com"],
    ["Grep", "search", "Search *.ts"],
    ["mcp__context7__query-docs", "mcp", "context7 · query-docs"],
    ["Bash", "bash", "$ gh pr create"],
  ]);
  assert.equal(pick(evs, "test_fail")[0].isError, true);
  assert.equal(pick(evs, "tool_end")[0].isError, true);
  assert.deepEqual(pick(evs, "error").map((e) => e.summary), ["Interrupted", "API error"]);
  assert.equal(evs.find((e) => e.model)?.model, "claude-opus-5-5");
  // msg_1 streams twice (output 5 -> 40): counted once, 115 + 35. Then 115 for each of msg_2..msg_9.
  const tokens = evs.reduce((n, e) => n + (e.tokens ?? 0), 0);
  assert.equal(tokens, 150 + 115 * 8);
});

test("claude: subagent transcript is an intern that leaves on end_turn", () => {
  const info = P.claudeFileInfo(join(FX, CLAUDE_SUB));
  assert.equal(info.sessionId, CLAUDE_SID);
  assert.equal(info.agentId, "a1b2c3d4e5f6a7b8c");
  assert.ok(info.parentPath.endsWith(`${CLAUDE_SID}.jsonl`));
  const evs = run(P.createClaudeState({ ...info, role: "Explore" }), P.parseClaudeLine, CLAUDE_SUB);
  assertPrivate(evs);
  assert.deepEqual(kinds(evs), ["subagent_start", "prompt", "tool_start", "tool_end", "reply", "subagent_end"]);
  for (const e of evs) {
    assert.equal(e.workerId, "agent-a1b2c3d4e5f6a7b8c");
    assert.equal(e.parentId, CLAUDE_SID);
    assert.equal(e.role, "Explore");
  }
  assert.equal(pick(evs, "tool_start")[0].summary, "Search *.ts");
});

test("claude: legacy sidechain lines in the parent file become an intern", () => {
  const st = P.createClaudeState({ sessionId: "s1" });
  const line = (o) => JSON.stringify({ sessionId: "s1", cwd: "/w/app", timestamp: "2026-01-15T10:00:00Z", ...o });
  const evs = [
    line({ type: "assistant", message: { id: "m1", model: "m", content: [{ type: "tool_use", id: "t1", name: "Task", input: { subagent_type: "general-purpose" } }], stop_reason: "tool_use" } }),
    line({ type: "assistant", isSidechain: true, message: { id: "m2", model: "m", content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/w/app/a.ts" } }], stop_reason: "tool_use" } }),
    line({ type: "assistant", isSidechain: true, message: { id: "m3", model: "m", content: [{ type: "text", text: "done" }], stop_reason: "end_turn" } }),
  ].flatMap((l) => P.parseClaudeLine(st, l));
  const intern = evs.filter((e) => e.parentId === "s1");
  assert.deepEqual(kinds(intern), ["subagent_start", "tool_start", "reply", "subagent_end"]);
  assert.equal(intern[0].role, "general-purpose");
});

test("claude: background test runs and denied calls produce no verdict", () => {
  const st = P.createClaudeState({ sessionId: "s2" });
  const L = (o) => JSON.stringify({ sessionId: "s2", cwd: "/w", timestamp: "2026-01-15T10:00:00Z", ...o });
  const evs = [
    L({ type: "assistant", message: { id: "a", content: [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "npm test", run_in_background: true } }], stop_reason: "tool_use" } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "Command running in background with ID: x" }] }, toolUseResult: { backgroundTaskId: "x" } }),
    L({ type: "assistant", message: { id: "b", content: [{ type: "tool_use", id: "b2", name: "Bash", input: { command: "npm test" } }], stop_reason: "tool_use" } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b2", is_error: true, content: "The user doesn't want to proceed with this tool use." }] } }),
    L({ type: "assistant", message: { id: "c", content: [{ type: "tool_use", id: "b3", name: "Bash", input: { command: "npm test | tail -3" } }], stop_reason: "tool_use" } }),
    L({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b3", content: "Tests: 1 failed, 2 passed" }] } }),
  ].flatMap((l) => P.parseClaudeLine(st, l));
  assert.deepEqual(pick(evs, "test_fail").length, 1, "only the piped run, read from its output");
  assert.equal(pick(evs, "test_pass").length, 0);
});

test("command code v3: tools, tests, intern, reply, error", () => {
  const evs = run(P.createCommandCodeState({ sessionId: "aB3dE5gH7jK9mN1pQ3sT5" }), P.parseCommandCodeLine, CC_V3);
  assertPrivate(evs);
  const main = evs.filter((e) => !e.parentId);
  const intern = evs.filter((e) => e.parentId);
  assert.deepEqual(kinds(main), [
    "session_start", "prompt", "thinking", "tool_start", "tool_start", "tool_end", "test_fail", "tool_end",
    "tool_start", "tool_end", "tool_start", "tool_end", "test_pass", "thinking", "reply", "waiting", "error",
  ]);
  assert.deepEqual(kinds(intern), ["subagent_start", "thinking", "subagent_end"]);
  assert.equal(intern[0].parentId, "aB3dE5gH7jK9mN1pQ3sT5");
  assert.equal(intern[0].role, "general");
  assert.ok(intern[0].workerId.startsWith("aB3dE5gH7jK9mN1pQ3sT5~"));
  assert.equal(main[0].project, "demo-app");
  assert.equal(main[0].model, "deepseek/deepseek-v4-pro");
  assert.deepEqual(pick(main, "tool_start").map((e) => [e.tool, e.category, e.summary]), [
    ["shell_command", "bash", "$ go test"],
    ["read_file", "read", "Read main.go"],
    ["agent", "agent", "Spawn general"],
    ["shell_command", "bash", "$ go test"],
  ]);
  assert.equal(evs.reduce((n, e) => n + (e.tokens ?? 0), 0), 120 + 60 * 3);
});

test("command code legacy: tool role results, error-text, piped test read from output", () => {
  const evs = run(P.createCommandCodeState({ sessionId: "legacy-0001", cwd: "/tmp/demo-app" }), P.parseCommandCodeLine, CC_LEGACY);
  assertPrivate(evs);
  assert.deepEqual(kinds(evs), [
    "session_start", "prompt", "thinking", "tool_start", "tool_start", "tool_end", "tool_end", "test_fail", "thinking", "reply", "waiting",
  ]);
  assert.equal(pick(evs, "tool_end")[0].isError, true);
  assert.equal(pick(evs, "tool_start")[0].summary, "List src");
  assert.equal(pick(evs, "test_fail")[0].summary, "$ npm run test:unit");
});

test("codex: session with code mode, long-running test, patch, mcp, web search", () => {
  const evs = run(P.createCodexState({ sessionId: CODEX_ID }), P.parseCodexLine, CODEX_MAIN);
  assertPrivate(evs);
  assert.deepEqual(kinds(evs), [
    "session_start", "prompt", "thinking",
    "tool_start", "tool_end", "test_fail", // exit 101
    "tool_start", "tool_end", // apply_patch: patch_apply_end and the output item report it once
    "tool_start", "tool_end", // cargo test still running in session 7
    "tool_start", "tool_end", "test_pass", // write_stdin sees session 7 exit 0
    "tool_start", "tool_end", // code-mode rg
    "tool_start", "tool_end", // mcp
    "tool_start", "tool_end", // spawn_agent
    "tool_start", "tool_end", // web search
    "thinking", "reply", "waiting",
    "prompt", "error",
  ]);
  const starts = pick(evs, "tool_start");
  assert.deepEqual(starts.map((e) => [e.tool, e.category, e.summary]), [
    ["exec_command", "bash", "$ cargo test"],
    ["apply_patch", "edit", "Edit lib.rs, new.rs"],
    ["exec_command", "bash", "$ cargo test"],
    ["write_stdin", "bash", "$ stdin"],
    ["exec_command", "search", "$ rg"],
    ["mcp__context7__query_docs", "mcp", "context7 · query_docs"],
    ["spawn_agent", "agent", "Spawn agent"],
    ["web_search", "web", "Web search"],
  ]);
  assert.equal(pick(evs, "test_pass")[0].summary, "$ cargo test");
  assert.equal(evs[0].project, "demo-app");
  assert.equal(evs.find((e) => e.model).model, "gpt-6-codex");
  // Two identical token_count events count once.
  assert.equal(evs.reduce((n, e) => n + (e.tokens ?? 0), 0), 1200);
  assert.equal(pick(evs, "error")[0].summary, "Interrupted");
});

test("codex: subagent rollout names its parent; a forked-in session_meta does not take over", () => {
  assert.equal(P.codexSessionId(join(FX, CODEX_SUB)), CODEX_SUB_ID);
  const st = P.createCodexState({ sessionId: CODEX_SUB_ID });
  const evs = run(st, P.parseCodexLine, CODEX_SUB);
  assertPrivate(evs);
  // Codex threads stay open for follow-ups: a finished turn leaves the intern at its desk, done.
  assert.deepEqual(kinds(evs), ["subagent_start", "prompt", "tool_start", "tool_end", "reply", "idle"]);
  for (const e of evs) {
    assert.equal(e.workerId, CODEX_SUB_ID);
    assert.equal(e.parentId, CODEX_ID);
    assert.equal(e.role, "Noether");
    assert.equal(e.cwd, "/tmp/demo-app");
  }
  assert.equal(pick(evs, "tool_start")[0].category, "read"); // sed -n
});

test("codex: code-mode cell that keeps running resolves its test on wait", () => {
  const st = P.createCodexState({ sessionId: "c1" });
  const L = (type, payload) => JSON.stringify({ timestamp: "2026-01-15T10:00:00Z", type, payload });
  const evs = [
    L("session_meta", { id: "c1", cwd: "/w/api" }),
    L("response_item", { type: "custom_tool_call", name: "exec", call_id: "x1", input: 'const r = await tools.exec_command({"cmd":"go test ./...","yield_time_ms":1000});' }),
    L("response_item", { type: "custom_tool_call_output", call_id: "x1", output: [{ type: "input_text", text: "Script running with cell ID 12\nWall time 1.0 seconds" }] }),
    L("response_item", { type: "function_call", name: "wait", arguments: '{"cell_id":"12"}', call_id: "x2" }),
    L("response_item", { type: "function_call_output", call_id: "x2", output: [{ type: "input_text", text: 'Script completed\nOutput:\n{"exit_code":1,"output":"--- FAIL: TestA"}' }] }),
  ].flatMap((l) => P.parseCodexLine(st, l));
  assert.deepEqual(kinds(evs), ["session_start", "tool_start", "tool_end", "tool_start", "tool_end", "test_fail"]);
  assert.equal(evs[1].summary, "$ go test");
  assert.equal(evs.at(-1).summary, "$ go test");
});

test("codex: older shell tool with argv and JSON output", () => {
  const st = P.createCodexState({ sessionId: "c2" });
  const L = (type, payload) => JSON.stringify({ timestamp: "2026-01-15T10:00:00Z", type, payload });
  const evs = [
    L("response_item", { type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "pytest -q"] }), call_id: "s1" }),
    L("response_item", { type: "function_call_output", call_id: "s1", output: JSON.stringify({ output: "1 passed", metadata: { exit_code: 0 } }) }),
    L("event_msg", { type: "exec_command_end", call_id: "s1", exit_code: 0 }),
  ].flatMap((l) => P.parseCodexLine(st, l));
  assert.deepEqual(kinds(evs), ["session_start", "tool_start", "tool_end", "test_pass"]);
  assert.equal(evs[1].summary, "$ pytest");
});

test("parsers survive junk", () => {
  const junk = ["", "   ", "null", "[]", "42", '"str"', "{", '{"type":"assistant","message":null}', '{"type":"user","message":{"content":[null,1,"x"]}}',
    '{"type":"message","message":{"role":"assistant","content":[{"type":"tool_use"}]}}', '{"type":"response_item","payload":{"type":"function_call","arguments":"{bad"}}',
    '{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":"x"}}}}', '{"role":"tool","content":[{"type":"tool-result","output":null}]}'];
  const states = [
    [P.createClaudeState({ sessionId: "j" }), P.parseClaudeLine],
    [P.createCommandCodeState({ sessionId: "j" }), P.parseCommandCodeLine],
    [P.createCodexState({ sessionId: "j" }), P.parseCodexLine],
  ];
  for (const [st, parse] of states) for (const l of junk) assert.doesNotThrow(() => parse(st, l), l);
});
