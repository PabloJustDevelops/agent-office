/*
 * The one chat turn the launch video plays, written for the control mock's
 * player API exactly like web/ui/dev/chat-scripts.mjs (say, tool, ask, think;
 * Claude Code's own tool names, the office's redacted labels). The project is
 * the demo's fictional cli-kit. The test run asks first, so it can be allowed
 * with one key.
 */

const ARGS_DIFF = [
  "@@ -12,6 +12,7 @@ export interface Flags {",
  "   color: boolean;",
  "   width?: number;",
  "+  json: boolean;",
  " }",
];

const TABLE_DIFF = [
  "@@ -31,4 +31,6 @@ export function table(rows: Row[], f: Flags) {",
  "+  if (f.json) return JSON.stringify(rows, null, 2);",
  "+",
  "   const widths = columns(rows, f.width);",
  "   return rows.map((r) => line(r, widths)).join(\"\\n\");",
];

const TEST_GREEN = `> cli-kit@1.4.0 test
> node --test

 ✔ args parses --json (2.1ms)
 ✔ table prints rows as JSON (1.4ms)
 ✔ table pads columns (0.9ms)
 ℹ tests 24  pass 24  fail 0`;

async function jsonFlag(p) {
  await p.think(500);
  await p.tool({ tool: "Read", category: "read", summary: "Read table.ts", ms: 220, detail: "88 lines" });
  await p.tool({ tool: "Read", category: "read", summary: "Read args.ts", ms: 160, detail: "64 lines" });
  await p.say("The table only prints padded text. I'll add a `--json` flag that hands back the rows as JSON instead.");
  await p.tool({ tool: "Edit", category: "edit", summary: "Edit args.ts", ms: 260, diff: { file: "src/args.ts", added: 1, removed: 0, lines: ARGS_DIFF } });
  await p.tool({ tool: "Edit", category: "edit", summary: "Edit table.ts", ms: 300, diff: { file: "src/table.ts", added: 2, removed: 0, lines: TABLE_DIFF } });
  const run = await p.ask({ tool: "Bash", category: "bash", summary: "$ npm test", ms: 1400, detail: TEST_GREEN });
  await p.think(400);
  if (run === "allow") await p.say("Done: `cli-kit list --json` prints the rows as JSON, and all **24 tests pass**.", { final: true });
  else await p.say("Okay, I didn't run the tests. The change is in `src/args.ts` and `src/table.ts`.", { final: true });
}

export function pick() {
  return jsonFlag;
}
