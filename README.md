<div align="center">

<a href="https://github.com/bas3line/agent-office">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ascii.rest/banner/agent%20office.dark.svg?color=d97757,8e75ff&tagline=your%20coding%20agents%2C%20working%20in%20a%20pixel%20office">
    <img alt="agent office: your coding agents, working in a pixel office" src="https://ascii.rest/banner/agent%20office.svg?color=d97757,8e75ff&tagline=your%20coding%20agents%2C%20working%20in%20a%20pixel%20office">
  </picture>
</a>

<br>
<br>

<img src="docs/demo.gif" alt="The demo office in stream mode: workers walk out of the lift one by one, sandboxed agents beam into the cloud wing, then a Claude Code worker fails pnpm test, the camera punches in and the desk flips over" width="100%">

<br>

Claude Code, Codex, Command Code and five more agents, working in a live pixel-art office.<br>
On this machine, in Daytona, Vercel and Railway sandboxes, or over ssh. A failing test flips the table.

[install](#install) · [what you're looking at](#what-youre-looking-at) · [agents](#supported-agents) · [sandboxes](#sandboxes-and-ssh-boxes) · [mcp + skill](#with-an-ai-coding-agent) · [privacy](#privacy) · [contributing](CONTRIBUTING.md)

[![by @bas3line](https://img.shields.io/badge/by-%40bas3line-181717?logo=github&logoColor=white)](https://github.com/bas3line)
[![CI](https://github.com/bas3line/agent-office/actions/workflows/ci.yml/badge.svg)](https://github.com/bas3line/agent-office/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/theagentoffice?color=181717&logo=npm&logoColor=white)](https://www.npmjs.com/package/theagentoffice)
[![MIT](https://img.shields.io/badge/license-MIT-181717)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-181717?logo=typescript&logoColor=white)](tsconfig.json)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-181717)](package.json)

</div>

<br>

Written in TypeScript by [@bas3line](https://github.com/bas3line). `npx theagentoffice` reads the transcripts your agents already write and turns them into an office you can watch: every session is a worker at a desk, subagents are interns who walk in from the lift, a raised hand means an agent is waiting on you, and a failing `npm test` gets the table flipped. One command, zero dependencies, nothing to configure, nothing leaves your machine.

<p align="center">
  <img src="docs/hero.png" width="49%" alt="The office at full size: one desk per agent on the left, a glass cloud wing of Daytona, boat, Railway and Vercel sandboxes on the right, a Claude Code worker who just flipped a table">
  <img src="docs/ascii.png" width="49%" alt="The same office in ASCII mode">
</p>

<p align="center">
  <img src="docs/logos/claude.svg" width="26" alt="Claude Code">&nbsp;
  <img src="docs/logos/codex.svg" width="26" alt="Codex">&nbsp;
  <img src="docs/logos/commandcode.svg" width="26" alt="Command Code">&nbsp;
  <img src="docs/logos/opencode.svg" width="26" alt="opencode">&nbsp;
  <img src="docs/logos/cursor.svg" width="26" alt="Cursor">&nbsp;
  <img src="docs/logos/droid.svg" width="26" alt="Droid">&nbsp;
  <img src="docs/logos/qwen.svg" width="26" alt="Qwen Code">&nbsp;
  <img src="docs/logos/gemini.svg" width="26" alt="Gemini CLI">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="docs/logos/daytona.svg" width="26" alt="Daytona">&nbsp;
  <img src="docs/logos/vercel.svg" width="26" alt="Vercel Sandbox">&nbsp;
  <img src="docs/logos/railway.svg" width="26" alt="Railway">&nbsp;
  <img src="docs/logos/boat.svg" width="26" alt="boat">
</p>

## Why

I run Claude Code, Command Code and Codex side by side most days, some of them in sandboxes. A wall of terminals doesn't tell you who's stuck, who's waiting on you and who just broke the tests. I wanted to see all of it at a glance, and I wanted it to be fun enough to leave open on a second screen. So I gave my agents an office.

## Install

```sh
npx theagentoffice          # your real agents (Node 18+)
npx theagentoffice --demo   # a busy simulated office, for a first look or a recording
```

It opens `http://127.0.0.1:4747`. Start Claude Code, Codex or any agent below in another terminal and it walks in; quit it and it walks back to the lift. `npm install -g theagentoffice` gives you the `agentoffice` command instead.

Something good just happened? Press <kbd>R</kbd>: the office keeps a rolling buffer and saves the last ~15 seconds as a clip, with a caption for the moment burned in. <kbd>H</kbd> turns on stream mode, where the camera cuts to every flip, shout and arrival. The demo starts from the top for each new viewer, so every recording opens on the arrivals.

## What you're looking at

| in the office | what happened |
| --- | --- |
| A worker walks out of the lift to a desk | A session started (sandboxed agents beam into the cloud wing instead) |
| A paper plane lands on the desk | You sent a prompt |
| Thought bubble | The model is thinking |
| Fast typing, code on the monitor | Editing files |
| Terminal on the monitor | Running a command |
| A page scrolling on the monitor | Reading files |
| Magnifier sweeping the monitor | Grep, glob, search |
| Spinning globe | Web fetch or search |
| A plug | An MCP tool call |
| Sticky notes pile up | Todo list or plan updates |
| The worker points, an intern walks in | A subagent was spawned; it clocks out when it's done |
| Leaning back, "supervising 3 interns" | The turn ended while its subagents keep working |
| Hand up, a bobbing "!" and the amber **needs you** button | The agent finished and is waiting on you; the button jumps to it |
| Leaning back, then asleep | Idle for a while |
| Smoke from the monitor | A tool call failed |
| Red alarm | API error or an interrupted turn |
| **(╯°□°)╯︵ ┻━┻** | **A test command failed.** Hit-stop, the camera punches in, the desk lands legs-up; later ┬─┬ノ( º _ ºノ) |
| A cheer, the monitor goes green | Tests passed |
| Walks back to the lift | The agent quit (or went quiet for 20 minutes) |
| Mood chip over the head, megaphone, confetti | The agent used the office's own MCP tools |

One pod per project: two agents on the same repo share it, each desk in its own agent's colours. The wall TV keeps score, the office follows your clock from morning to night, it rains now and then, and there is a cat.

## Supported agents

| | agent | reads | status |
| --- | --- | --- | --- |
| <img src="docs/logos/claude.svg" width="18"> | **Claude Code** | `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR`), subagents included | tested |
| <img src="docs/logos/codex.svg" width="18"> | **Codex** | `~/.codex/sessions` (or `$CODEX_HOME`), subagents included | tested |
| <img src="docs/logos/commandcode.svg" width="18"> | **Command Code** | `~/.commandcode/projects`, v3 and legacy formats | tested |
| <img src="docs/logos/opencode.svg" width="18"> | **opencode** | `~/.local/share/opencode/opencode.db` (read-only SQLite) | tested |
| <img src="docs/logos/cursor.svg" width="18"> | **Cursor** (cursor-agent) | `~/.cursor/projects` | tested; Cursor records no tool results, so no pass/fail |
| <img src="docs/logos/droid.svg" width="18"> | **Droid** (Factory) | `~/.factory/sessions` | tested |
| <img src="docs/logos/qwen.svg" width="18"> | **Qwen Code** | `~/.qwen/projects` | tested |
| <img src="docs/logos/gemini.svg" width="18"> | **Gemini CLI** | `~/.gemini/tmp/*/chats` | built from gemini-cli's recorder source, untested on real data |

"Tested" means checked against real transcripts on a real machine, every file, with zero crashes and zero prompt text in any label. Formats drift between versions: if your agent stops showing up, [open an issue](https://github.com/bas3line/agent-office/issues/new/choose) with its version. Want another agent? [CONTRIBUTING.md](CONTRIBUTING.md#add-an-agent) shows how to add one.

## Sandboxes and ssh boxes

Agents in cloud sandboxes or on another machine sit in a glass-walled **cloud wing** next to the office, one pod per sandbox, its sign naming the platform. Nothing is installed on the remote: the office runs plain POSIX `sh` (`find`, `stat`, `tail`, `base64`) through the platform's own exec and reads the transcripts there, exactly as it does locally.

| | where | how it connects | status |
| --- | --- | --- | --- |
| <img src="docs/logos/vercel.svg" width="18"> | **Vercel Sandbox** | `VERCEL_TOKEN` / `VERCEL_OIDC_TOKEN`, or the `npx sandbox` CLI's login | tested |
| <img src="docs/logos/daytona.svg" width="18"> | **Daytona** | `DAYTONA_API_KEY`, or the `daytona` CLI's login | tested |
| <img src="docs/logos/railway.svg" width="18"> | **Railway Sandboxes** | `RAILWAY_API_TOKEN`, or the `railway` CLI's login | tested |
| <img src="docs/logos/boat.svg" width="18"> | **boat** | `BOAT_API_KEY`, or the `boat` CLI; only with `--boat` | built from docs.boat.dev, untested on a real VM |
| | **any ssh box** | your own `ssh`, `BatchMode=yes`, one multiplexed connection | beta |

**Auto-detect.** On start the office looks for those keys and logins (files and environment only) and watches the running sandboxes in your own scope, so a teammate's sandbox never ends up in your recording: your default Vercel team, the Railway project linked to the folder plus the sandboxes your CLI created, and your personal Daytona organization. boat keeps every command's output for 90 days, so it is watched only when you ask with `--boat`. `--no-cloud` turns auto-detect off.

| flag | |
| --- | --- |
| `--vercel [name]`, `--daytona [id]`, `--railway [id]`, `--boat [id]` | watch these; no value means every running one the login can see |
| `--ssh <host>` | an alias, `user@host` or `ssh://user@host:port`; repeatable |
| `--local-only` | this machine only |

Remotes you always want go in `~/.agentoffice/config.json`:

```json
{
  "remotes": [{ "ssh": "me@gpu-box" }, { "vercel": "all" }, { "daytona": "all" }],
  "cloud": true
}
```

A quiet poll is one exec of a few hundred bytes. Polls back off when a host stops answering (it dims and shows OFFLINE), idle Daytona and Railway sandboxes are left alone so they can still auto-stop, and expired logins are reported, never refreshed behind your back.

### Claude in a Vercel Sandbox, in your office

```sh
npx sandbox@latest login     # once; the office reuses this login
npx sandbox@latest sh --rm   # a fresh sandbox, removed when you exit
claude                       # inside it; Claude Code, Codex and opencode are preinstalled
```

Claude Code signs in separately inside the sandbox. On your machine, `npx theagentoffice` finds the sandbox and the worker beams into the cloud wing.

## With an AI coding agent

Agents can talk back. `agentoffice mcp` is a zero-dependency MCP server with five tools, and a short skill teaches agents when to use them:

| tool | what it does |
| --- | --- |
| `office_status {text, mood?}` | the status line and emoji floating over the agent's head |
| `office_peers {}` | who else is working right now and which files they just edited; agents in the same repo come first, with a heads-up before two of them edit the same file |
| `office_shout {text}` | a milestone on the office TV and in a toast (rate-limited) |
| `office_celebrate {reason?}` | confetti at the agent's desk |
| `office_flip {reason?}` | the agent flips its own table, in its own words (once every 2 minutes per repo) |

Install both into every agent on the machine at once:

```sh
npx theagentoffice install --dry-run   # the plan, and the exact diff of every file it would touch
npx theagentoffice install             # do it
npx theagentoffice doctor              # what's installed where, and is the office running
npx theagentoffice uninstall           # every file back the way it was
```

It uses each agent's own mechanism (`claude mcp add`, `codex mcp add`, or its MCP JSON, plus its skills folder), touches only the agents it finds, backs up every file first, and keeps your comments and formatting. Re-running is a no-op. Add `--vercel all` or `--ssh me@gpu-box` to install inside sandboxes and boxes too. Everything an agent sends is scrubbed before it reaches the screen: paths become file names, URLs become host names, anything that looks like a secret becomes `•••`.

## Privacy

agent office is built to be screen-recorded.

- **Local only.** The server binds `127.0.0.1`, rejects foreign `Host` headers and cross-site requests, and sends a strict CSP. `--host` exists and warns you when you use it.
- **Read-only.** It never writes to your agents' transcripts or configs; only `install` touches configs, and only when you ask.
- **Nothing leaves your machine**, except the calls to the sandbox platforms and ssh boxes you're logged in to or configured. No telemetry, no CDN; it works offline.
- **Labels, not content.** What reaches the browser is an action and a file name, "Edit auth.ts", "$ npm test". Never prompt text, file contents, command arguments past the subcommand, or anything that looks like a key. Your home directory shows as `~`, and IPs are masked.

## How it works

```
 ~/.claude  ~/.codex  ~/.commandcode  opencode.db  ...      sandboxes / ssh boxes
        \        |         |            /                   (same reads, over sh)
         ingest: one small parser per agent  <──────────────────────┘
                 │  "worker X started Edit auth.ts"
         state:  re-redacts; who's here, who quit (ps), who went quiet
                 │  Server-Sent Events on 127.0.0.1
         browser: Canvas 2D office drawn at pixel resolution, scaled crisp
```

The CLI tails transcript folders, backfills sessions active in the last 30 minutes, watches which agent processes are running so a session leaves when its agent quits, and streams one event per line it understands. The office is drawn at true pixel-art resolution into an offscreen buffer and scaled up with crisp pixels; labels, ASCII mode and CRT are passes on the same canvas, so screenshots and clips include them. No framework, no runtime dependencies: one bundled `dist/cli.js` and one bundled web app.

## CLI

```sh
npx theagentoffice [office] [options]     # open the office (the default command)
npx theagentoffice <command> [options]    # install | uninstall | doctor | mcp
```

| option | |
| --- | --- |
| `--port <n>`, `-p` | port, 4747 by default; tries the next 20 if taken |
| `--host <addr>` | interface to bind, `127.0.0.1` by default |
| `--agents <list>` | `claude,commandcode,codex,opencode,droid,gemini,qwen,cursor`, all by default |
| `--demo` | a simulated office; reads no transcripts |
| `--seed <n>` | demo seed, for reproducible recordings |
| `--no-open` | don't open the browser |
| `-q`, `--quiet` | banner only, no arrivals or flips in the terminal |
| `--verbose` | log what the watchers are doing |
| `--no-cloud`, `--local-only` | no sandbox auto-detect; this machine only |

`AGENT_OFFICE_HOME` moves `~/.agentoffice`, and `AGENT_OFFICE_<AGENT>_DIR` points one agent at a non-default folder.

| key | |
| --- | --- |
| <kbd>A</kbd> | pixel or ASCII |
| <kbd>C</kbd> | CRT scanlines |
| <kbd>S</kbd> | PNG screenshot |
| <kbd>R</kbd> | clip that: save the last ~15 seconds |
| <kbd>Shift</kbd>+<kbd>R</kbd> | record the next 10 seconds |
| <kbd>H</kbd> | stream mode: hide the chrome, the camera cuts in on every big moment |
| <kbd>F</kbd> | fullscreen |
| <kbd>M</kbd> | sound, off by default |
| <kbd>\\</kbd> | show or hide the activity feed |
| <kbd>?</kbd> | every shortcut |

Click a worker for its inspector: model, host, tool calls, tokens, recent actions. Scroll to zoom, drag to pan, double-click to reset.

## Contributing

New agents, sandbox platforms, fixes and ideas are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers how it fits together, how to add an agent, the privacy rules every label follows and how to open a pull request, and the [code of conduct](CODE_OF_CONDUCT.md) applies everywhere. Found a security problem? See [SECURITY.md](SECURITY.md).

## Trademarks

Claude, Codex, Command Code, opencode, Cursor, Droid and Factory, Qwen, Gemini, Daytona, boat, Railway and Vercel are trademarks of their owners. Their logos appear only to name those products, mostly from [Simple Icons](https://github.com/simple-icons/simple-icons) (CC0) and the owners' own marks; agent office is not affiliated with or endorsed by any of them. Codex is shown as a neutral hexagon rather than OpenAI's logo.

## Author

Made by [@bas3line](https://github.com/bas3line). If you use it, a link back is appreciated, and so is a star.

To support it: [GitHub Sponsors](https://github.com/sponsors/bas3line), [Buy Me a Coffee](https://buymeacoffee.com/bas3line) or [PayPal](https://paypal.me/ShubhamYadav886).

## License

MIT, © [@bas3line](https://github.com/bas3line)
