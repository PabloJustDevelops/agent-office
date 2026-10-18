/*
 * Which coding agents are running on this machine right now, and in which
 * folder. Transcripts never say "I exited", so without this a session that
 * quit lingers until GONE_MS; with it the office sends it home within seconds.
 * macOS: `ps` for the command lines, one `lsof` call for every match's cwd.
 * Linux: `ps`, then /proc/<pid>/cwd. Anywhere else the answer is "unknown"
 * (null) and the office falls back to the quiet timer.
 */
import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import type { AgentKind } from "../shared/events.ts";

export interface AgentProcess {
  pid: number;
  agent: AgentKind;
  /** Absolute working folder, with macOS's /private prefix folded away. */
  cwd: string;
}

/** Executable names, matched exactly (so "Claude", the desktop app, is not "claude"). */
const BINARIES: Record<string, AgentKind> = {
  claude: "claude",
  "command-code": "commandcode",
  commandcode: "commandcode",
  codex: "codex",
  opencode: "opencode",
  droid: "droid",
  gemini: "gemini",
  qwen: "qwen",
  "cursor-agent": "cursor",
};

/** Package paths of agents that run as a script under a JS runtime. */
const SCRIPTS: [RegExp, AgentKind][] = [
  [/@anthropic-ai\/claude-code\//, "claude"],
  [/@openai\/codex\//, "codex"],
  [/@google\/gemini-cli\//, "gemini"],
  [/@qwen-code\/qwen-code\//, "qwen"],
  [/[\\/]opencode-ai\//, "opencode"],
  [/[\\/]command-?code[\\/]/, "commandcode"],
];
const RUNTIMES = new Set(["node", "bun", "deno"]);

const base = (p: string) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);

/** The agent a command line belongs to, or null. */
export function matchAgent(args: string): AgentKind | null {
  const argv = args.trim().split(/\s+/);
  const exe = base(argv[0] ?? "");
  if (Object.hasOwn(BINARIES, exe)) return BINARIES[exe]!;
  if (!RUNTIMES.has(exe)) return null;
  // node [flags] <script>: the first non-flag argument is the script.
  const script = argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
  if (Object.hasOwn(BINARIES, base(script))) return BINARIES[base(script)]!;
  for (const [re, agent] of SCRIPTS) if (re.test(script)) return agent;
  return null;
}

/** /private/tmp and /tmp are the same folder on macOS; transcripts may record either. */
export function foldPrivate(p: string): string {
  return /^\/private\/(tmp|var|etc)(\/|$)/.test(p) ? p.slice("/private".length) : p;
}

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((done) => {
    execFile(cmd, args, { timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => done(err && !stdout ? null : stdout));
  });
}

/** Every agent process with its cwd; null when this platform can't tell. */
export async function scanAgentProcesses(): Promise<AgentProcess[] | null> {
  if (process.platform !== "darwin" && process.platform !== "linux") return null;
  const ps = await run("ps", process.platform === "darwin" ? ["-axo", "pid=,args="] : ["-eo", "pid=,args="]);
  if (ps === null) return null;
  const found: { pid: number; agent: AgentKind }[] = [];
  for (const line of ps.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    const agent = matchAgent(m[2]!);
    if (agent) found.push({ pid, agent });
  }
  if (!found.length) return [];
  const cwds = new Map<number, string>();
  if (process.platform === "darwin") {
    // -a: AND the filters; -d cwd: only the cwd entry; -F pn: machine-readable pid / name lines.
    const out = await run("lsof", ["-a", "-d", "cwd", "-p", found.map((f) => f.pid).join(","), "-Fpn"]);
    if (out === null) return null;
    let pid = 0;
    for (const line of out.split("\n")) {
      if (line[0] === "p") pid = Number(line.slice(1));
      else if (line[0] === "n" && pid) cwds.set(pid, line.slice(1));
    }
  } else {
    await Promise.all(found.map(async (f) => {
      const cwd = await readlink(`/proc/${f.pid}/cwd`).catch(() => null);
      if (cwd) cwds.set(f.pid, cwd);
    }));
  }
  // A process whose cwd can't be read (another user's, or gone mid-scan) is left out.
  return found.flatMap((f) => (cwds.has(f.pid) ? [{ ...f, cwd: foldPrivate(cwds.get(f.pid)!) }] : []));
}
