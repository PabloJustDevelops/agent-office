# The landing page

A static page whose hero is the real office: the scene from `web/scene`, driven by the `--demo` simulator from `src/demo` through the office state from `src/server/state.ts`, all running in the browser. No server, no framework, no runtime dependencies. The only thing it loads from elsewhere is its two typefaces, Geist and Geist Mono, from Google Fonts.

```sh
npm run site        # build into site/dist
npm run site:dev    # build, serve on http://127.0.0.1:5040 (or the next free port) and rebuild + reload on every change
```

`site/dist` is the whole site, deployed to https://theagentoffice.xyz on every push to main (see Deploying). Every path in it is relative, so it also works from a subfolder.

## What's here

| | |
| --- | --- |
| `index.html` | the page, with a few build-time tags: `<px-text>` (text in the office's bitmap font), `<i-logo>`, `<i-glyph>`, `<i-icon>`, `<i-mark>`, `<i-worker>` and `<i-walker>` (an agent's worker, drawn by `web/scene/sprites.ts`), `<i-city>` and `<i-moon>` (the footer's night) |
| `styles.css` | the page: colour tokens for dark (the default) and light, then every section |
| `main.ts` | the theme toggle, copy buttons, the boot, the pinned story, the live views, the activity feed and the "needs you" call, the redaction, the sparkles, F to flip a table, the tour player |
| `office.ts` | the browser adapter: demo -> state -> scene on one virtual clock, plus `trigger(moment)` |
| `shims/node.ts` | what `node:os`, `node:child_process` and `node:fs/promises` resolve to in the browser |
| `assets/` | the office stills, the og:image, the favicons, the app screenshots (`shots/`) |
| `tools/capture.mjs` | regenerates the images in `assets/` from the real page and the app's dev harness, in headless Chromium |
| `../scripts/build-site.mjs` | the build and the dev server |

The build reads the bitmap fonts (`web/scene/font.ts`), the workers (`web/scene/sprites.ts`), the glyphs and brand mark (`web/ui/icons.ts`), the palette (`web/scene/palette.ts`) and the agents' colours (`src/shared/events.ts`) straight from the app, so the page and the office stay one thing. Nothing in `web/` or `src/` is changed to build it, and the npm package doesn't include `site/`.

## The page

One accent, the office's own violet (`#8e75ff`), on a near-black page (light follows `prefers-color-scheme`, and the toggle in the nav remembers a choice). The office is the loud part:

- **The hero.** `npx theagentoffice` types itself out, then the office boots in its window. The window stands tilted on a faint floor and straightens as you scroll to it; once it's in place it has no transform at all, so the canvas is drawn pixel for pixel. The status bar shows who's at work and counts tool calls and flips since the page opened.
- **The story.** The office pins while seven cards scroll past it, and each one plays its moment in the office with the camera on it. On narrow screens the office pins at the top and the cards scroll under it; on short ones nothing pins.
- **Live views.** The small views in the MCP and cloud-wing cells are copied from the one running scene's canvas while a moment holds the camera there. There is no second scene.
- **In and around the window.** The office's own activity feed runs in the window's corner on wide screens (labels only, as in the app), and when an agent in the demo finishes its turn an amber "needs you" call appears at the top of the window, at most every 30 seconds; "Show me" brings the camera to it.
- **The rest.** The app's own screens (captured from its dev harness), a transcript line scrubbed down to its label, each agent's own worker standing in for its logo on hover, a running light on a bento cell's edge on hover, pixel sparkles under the cursor in the hero, a confetti puff when you copy the command, and F anywhere on the page flips a table.
- **The footer is a night scene,** generated at build time in the office's colours: the closing line in the sky with the moon and a shooting star now and then, the wordmark over the city, the office's own building in the middle (one floor per agent, its lift going up and down, its neon sign; a click on it goes back to the top), windows switching on and off, and the links on the street, where a worker walks by. It stays a night scene in light mode, and holds still while it's off screen.

Every animation moves `transform` and `opacity` only. With `prefers-reduced-motion` nothing animates: the office waits for a press of play, the command is simply there, and the live views don't start it.

## How the office runs without a server

`office.ts` wires the same pipe the CLI builds for `--demo`, minus the HTTP hop: `createDemo().onEvent -> OfficeState.ingest -> subscribe -> scene.apply`. Time is virtual: the demo, the state's idle timer and the moments all run on one clock that only moves while the office is running. It starts ten seconds in, so the page opens on a busy office.

The chunk with the office (about 87 KB gzipped) loads once the page has painted; until then, and under reduced motion, a still of it stands in. It runs only while the window or one of the live views is on screen and the tab is visible. The scene has no pause of its own, so pausing keeps a still of the last frame and destroys the scene; resuming creates a new one and loads the state's snapshot, like a reconnect.

Moments are played by injecting the events a real session would write, for a worker that's already seated (or a new one, for arrivals). A moment holds its worker for a few seconds: the demo's own events for it wait, and only the latest pose is replayed afterwards.

The wheel and drags over the office scroll the page instead of moving the camera; a click on a worker still zooms in on it.

## Build options

| variable | |
| --- | --- |
| `SITE_URL` | the site's address, e.g. `https://agent-office.example`. It makes `og:image`, `og:url` and the canonical link absolute, which social cards need. Set it for every production build. |
| `TOUR_VIDEO` | a path to the launch video (`.mp4` or `.webm`). See below. |
| `STARS_MIN` | the GitHub star count shows next to the nav's GitHub link only from this many stars on (default 50). |
| `GITHUB_STARS` | the star count, instead of asking the GitHub API at build time; `GITHUB_STARS=` hides it. If the API can't be reached the count is left out. |
| `SITE_OUT` | build somewhere other than `site/dist` |
| `PORT` | the dev server's port (default: the first free one from 5040) |

### The tour video

The hero has a "Watch the N-second tour" button that opens the video in a player. It's only on the page when there's a video: put it at `site/assets/tour.mp4` (or `tour.webm`), or point `TOUR_VIDEO` at it. The build copies it to `site/dist/assets/`, reads an mp4's length for the label, and picks up a `tour-poster.webp` or `tour-poster.jpg` next to the video as its poster. Without a video, the button and the player are left out of the page.

## Deploying

The site lives at **https://theagentoffice.xyz**, on Cloudflare Workers as static assets only (`wrangler.jsonc` at the repository root; no Worker code). Every push to `main` that touches the page or the office it runs (`site/`, `web/`, `src/`, `assets/`, the build script, the lockfile) rebuilds it and deploys it through `.github/workflows/site.yml`. It can also be run by hand from the Actions tab.

The workflow needs two repository secrets:

- `CLOUDFLARE_ACCOUNT_ID`: the account the `theagentoffice.xyz` zone is in.
- `CLOUDFLARE_API_TOKEN`: a token from Cloudflare's "Edit Cloudflare Workers" template, limited to that account and that zone.

To deploy from a machine instead, after `npx wrangler login`:

```sh
SITE_URL=https://theagentoffice.xyz npm run site && npx wrangler@4.151.1 deploy
```

A file in `site/dist` can be at most 25 MiB on Workers, so the tour video (`TOUR_VIDEO`) has to stay under that or be served from somewhere else (an R2 bucket, say) and pointed at by URL.

The build works anywhere that serves static files: set `SITE_URL` to where it will live and upload `site/dist`. Every path in it is relative, so a subfolder works too.

## Regenerating the images

`assets/office-wide.webp`, `assets/office-square.webp` and `assets/og.jpg` come from the built page, so they show the real office. `assets/shots/*.webp` come from the app's own dev harness (`web/ui/dev/dev-server.mjs --control`, a synthetic office and an in-memory control plane), which the tool starts and stops. They need playwright-core and a Chromium, neither of which is a dependency of the project:

```sh
npm i --no-save playwright-core && npx playwright-core install chromium
npm run site && node site/tools/capture.mjs            # or: ... capture.mjs og shots
```

While it runs, the tool serves the page on `127.0.0.1:5039` and the harness on `127.0.0.1:5038`. The favicons (`assets/favicon-32.png`, `assets/apple-touch-icon.png`) are drawn from the brand mark and kept as they are; the build writes `favicon.svg` from the mark itself.
