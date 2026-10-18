# The landing page

A static page whose hero is the real office: the scene from `web/scene`, driven by the `--demo` simulator from `src/demo` through the office state from `src/server/state.ts`, all running in the browser. No server, no framework, no runtime dependencies, nothing loaded from a CDN.

```sh
npm run site        # build into site/dist
npm run site:dev    # build, serve on http://127.0.0.1:4950 and rebuild + reload on every change
```

`site/dist` is the whole site: upload that folder anywhere that serves static files. Every path in it is relative, so it also works from a subfolder (GitHub Pages' `/agent-office/`).

## What's here

| | |
| --- | --- |
| `index.html` | the page, with a few build-time tags: `<px-text>` (headings in the office's bitmap font), `<i-logo>`, `<i-glyph>`, `<i-icon>`, `<i-mark>` |
| `styles.css` | the page; the office palette is prepended as CSS variables at build time |
| `main.ts` | copy buttons, tabs, the office window's toolbar, the legend's moments, pausing |
| `office.ts` | the browser adapter: demo -> state -> scene on one virtual clock, plus `trigger(moment)` |
| `shims/node.ts` | what `node:os`, `node:child_process` and `node:fs/promises` resolve to in the browser |
| `assets/` | the office still, the og:image, favicons, the control-plane screenshots, the ascii.rest banner |
| `tools/capture.mjs` | regenerates the images in `assets/` from the real page, in headless Chromium |
| `../scripts/build-site.mjs` | the build and the dev server |

The build reads the bitmap font (`web/scene/font.ts`), the glyphs and brand mark (`web/ui/icons.ts`) and the palette (`web/scene/palette.ts`) straight from the app, so the page and the office stay one thing. Nothing in `web/` or `src/` is changed to build it, and the npm package doesn't include `site/`.

## How the office runs without a server

`office.ts` wires the same pipe the CLI builds for `--demo`, minus the HTTP hop: `createDemo().onEvent -> OfficeState.ingest -> subscribe -> scene.apply`. Time is virtual: the demo, the state's idle timer and the moments all run on one clock that only moves while the office is running. It starts ten seconds in, so the page opens on a busy office and the first table flip lands a few seconds later.

It pauses when the office scrolls out of view, when the tab is hidden, when you press pause, and it waits for a click under `prefers-reduced-motion`. The scene has no pause of its own, so pausing keeps a still of the last frame and destroys the scene; resuming creates a new one and loads the state's snapshot, like a reconnect.

The legend plays moments by injecting the events a real session would write, for a worker that's already seated (or a new one, for arrivals). A moment holds its worker for a few seconds: the demo's own events for it wait, and only the latest pose is replayed afterwards.

The wheel and drags over the office scroll the page instead of moving the camera; a click on a worker still zooms in on it.

## Deploying

The owner picks the host; nothing here deploys itself. Set `SITE_URL` when building for production so `og:image`, `og:url` and the canonical link are absolute (social cards need that):

```sh
SITE_URL=https://agent-office.example npm run site
```

**Vercel.** Import the repository and set: Framework preset "Other", Build command `SITE_URL=https://<your domain> npm run site`, Output directory `site/dist`, Install command `npm ci`. Or deploy a local build as-is: `npm run site && npx vercel deploy site/dist --prod`. The files in `site/dist/assets` with a hash in their name can be cached forever.

**GitHub Pages.** Settings, Pages, Source: GitHub Actions, then add a workflow like this one (as `.github/workflows/site.yml`):

```yaml
name: site
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
      - run: npm ci
      - run: npm run site
        env:
          SITE_URL: https://bas3line.github.io/agent-office
      - uses: actions/upload-pages-artifact@v5
        with:
          path: site/dist
  deploy:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v5
```

A workflow deploy never runs Jekyll; the build also writes `site/dist/.nojekyll` for anyone who publishes the folder from a branch instead.

## Regenerating the images

`assets/office-still.webp`, `assets/og.png`, the favicons and `assets/shots/*.webp` are generated from the built page, so they show the real office. They need playwright-core and a Chromium, neither of which is a dependency of the project:

```sh
npm i --no-save playwright-core && npx playwright-core install chromium
npm run site && node site/tools/capture.mjs            # or: ... capture.mjs og still
```

The control-plane screenshots come from `tools/shots/*.png` and are written at 1440 and 960 wide.
