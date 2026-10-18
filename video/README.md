# The launch video

The launch film for agent office (a product tour, cut for a first-time viewer: the problem, the answer, then hiring Command Code into a Daytona sandbox from the page step by step, a short "and also" montage, how to use it, and the end card with the sponsor credit), and the README's demo media, rendered from the real office: every office frame is the scene from `web/scene` (`createOfficeScene`), fed by the real office state (`src/server/state.ts`) with events scripted from the demo's cast (`src/demo`), and the control shots are the real web app (`web/main.ts`) driven through its own buttons and keys. Nothing here is a mock-up of the office.

It renders deterministically: one virtual clock moves a frame at a time, so the same command gives the same frames, every time.

## Render it

macOS only (the encoder is AVFoundation, through `swiftc`; there is no ffmpeg dependency).

```sh
cd video
npm ci                                                   # playwright-core, gifenc, pngjs (dev only)
npx playwright-core install --only-shell chromium        # skip if a chrome-headless-shell is already in ~/Library/Caches/ms-playwright

npm run render:main         # the tour, 1920x1080, 60 fps, ~100 s, with sound; also agent-office-main-x.mp4 (10 Mbit/s, for X) and tour.mp4 + tour-poster.jpg (1280x720, 30 fps, for the website)
npm run render:social       # the 30 s cut, 1920x1080
npm run render:vertical     # the 30 s cut, 1080x1920 (the app at a phone's width, in its phone layout)
npm run render:square       # the 30 s cut, 1080x1080
npm run readme              # the README's demo.mp4 (1200 wide), demo.gif (960 wide) and five PNGs at 2x
```

Everything heavy goes to a work folder outside the repo (`$TMPDIR/agent-office-video` unless you pass `--work <dir>`); finished files go to `--out <dir>` (default `<work>/out`). Options:

| | |
| --- | --- |
| `--work <dir>`, `--out <dir>` | where intermediates and finished files go |
| `--review <s>` | don't encode: save a PNG every `<s>` seconds into `<work>/review/<cut>/`, to check pacing |
| `--from <s> --to <s>` | only capture this stretch (the frames before it still run, unseen, so the office is in the same state) |
| `--stills 10.2,20.4` | also save these moments as PNGs |
| `--fps <n>` | frame rate (60 for the films, 30 for the README's) |
| `CHROME=<path>` | the headless Chromium to use |

The main cut takes about half an hour on an M2 (pass `--fps 30` to a `--review` pass to halve it); a `--review 0.5` pass about two. `npm run typecheck` checks `src/` (it uses the root's TypeScript).

## How it works

| | |
| --- | --- |
| `src/vt.js` | virtual time: `setTimeout`, `setInterval`, `requestAnimationFrame`, `performance.now`, `Date` and `Math.random` on one clock, in the stage page and in the app's iframe. CSS animations are paused and scrubbed to it. |
| `src/world.ts` | the office: `OfficeState` plus a scripted cast built from the demo's own pieces (`emit`, `PROJECTS`, `TOOLSETS`, `MODELS`, `DEMO_HOSTS`). Background workers loop through reads, searches and edits; beats (a pose, interns, the flip, a hand up) are placed at exact world times and hold their worker while they play. |
| `src/script.ts` | what happens when, in world time: `tourScript2` and `TV` for the tour, `script` and `T` for the first cut (kept as `launch-v1`). |
| `src/tour.ts` | the tour: its features (the band's title and line, or the steps of a flow), its shots and its cuts: `main`, `social`, `vertical`, `square`. |
| `src/band.ts` | the feature band: a solid panel along the bottom, the title in the office's bitmap font (about 6.5% of the frame's height in 16:9), the line in Geist (about 4%), or a flow's numbered steps with the current one lit. |
| `src/flow.ts` | a shot of the real app doing things: clicks, typing, keys (with an on-screen key cap) and scrolls at set times, a cursor at a person's pace, a spotlight on the element in use, and a slow camera that frames the part of the app in play. |
| `src/sponsor.ts` | the "Sponsored by Command Code" credit, with Command Code's wordmark (`docs/sponsors/command-code.dark.svg`). |
| `src/stage.ts` | the renderer's page: video time vs world time (a shot can jump ahead, a cut, or slow the world down, the flip's slow motion), the scene, the camera, the cues for the sound. |
| `src/shots.ts`, `src/titles.ts`, `src/type.ts` | the office shots (camera moves through the scene's own `view()`, whole-number zooms at rest), the title shots, and the type: the office's bitmap font (`web/scene/font.ts`) drawn at whole-number scales, the palette from `web/scene/palette.ts`. |
| `src/uishots.ts`, `src/readme.ts` | the real app in an iframe: the "needs you" button, Hire, the chat panel, the approval answered with `1`. A cursor is drawn over it; the clicks and keys are real DOM events on the app's own elements. |
| `src/ui/` | the app's server, in the page: `bridge.ts` answers `/events` and `/api/control/*` on the virtual clock, `fakes.ts` swaps the app's `EventSource` and `fetch` for it before `web/main.ts` loads. |
| `src/audio.ts` | the sound, synthesised with an `OfflineAudioContext` from the cues the shots record: a 120 BPM pulse, keys, the lift's ding, the beam, the flip. No samples, no one else's music. |
| `src/cuts.ts` | every cut by name: the tour's, `launch-v1` (the first, feature-light cut), and the README's `readme`, `readme-gif` and `stills`. |
| `src/fonts/` | Geist SemiBold, Medium and Bold (SIL Open Font License, `OFL.txt`), for the band's line. |
| `tools/render.mjs` | builds, serves on 127.0.0.1 (ports 5051-5099), steps the page frame by frame, screenshots each frame and pipes it to the encoder. |
| `tools/encode.swift` | PNG frames in, H.264 out (VideoToolbox), then the AAC soundtrack muxed in without re-encoding; also `probe` and `frames` for checking an encode. |
| `tools/gif.mjs` | the README GIF: one global palette for the clip (median cut plus k-means at full precision, so the night doesn't band), no dithering, and each frame carries only what changed. |

## Copied, not imported

These had to change for the video, so they are copies; the originals are untouched:

- `src/ui/control-mock.js` from `web/ui/dev/control-mock.mjs`: runs in the browser on the virtual clock (no `node:crypto` or `Buffer`), fictional folders from the demo cast, no real host names, and an allowed test run reports `test_pass` to the office. Added, in the shapes of `src/shared/control.ts`: Settings › Logins (Claude connected), `GET /setup` (what Your setup lists, names only: the Claude rows with MCP servers and skills, keys and the project for other agents), Command Code with a key and chat mode (ACP), sandboxes named `agentoffice-…`, a remote worker that walks in once its sandbox exists, step times close to a real sandbox's (the video time-lapses them, and says so), and approvals that carry the full command.
- `src/ui/chat-scripts.js` replaces `web/ui/dev/chat-scripts.mjs` with the turns the video plays (same player API), in each agent's own tool names.
- `src/shims/node.ts` from `site/shims/node.ts`.

What the tour shows is what this branch does: in the hire form, chat mode in a sandbox is Claude Code and Codex on Railway or over ssh (Daytona and Vercel are terminal only), so the Command Code it hires into a Daytona sandbox is driven through its terminal, and its chat and approvals are shown on this Mac. Your setup for Command Code is its keys and the project; MCP servers, instructions and skills are shown on a Claude hire.

One override, in the stage page only: `Camera.prototype.within` (the clamp that keeps a hand-dragged camera on the floor plan) is skipped for the stage's scene, because the video's camera is placed every frame by the shots and the clamp would ease each move toward the middle. The app in the iframe is a separate bundle and keeps it.
