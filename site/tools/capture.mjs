// Regenerates the page's images from the real thing, in headless Chromium:
//
//   assets/office-still.webp   the hero office (shown until the live one starts, and under reduced motion)
//   assets/og.png              the 1200x630 Open Graph / Twitter card, from the real hero
//   assets/favicon-32.png, assets/apple-touch-icon.png   from favicon.svg (the brand mark)
//   assets/shots/*.webp        the control-plane screenshots in tools/shots/*.png, at 1440 and 960 wide
//
// Needs playwright-core and a Chromium, neither of them a dependency of the project:
//   npm i --no-save playwright-core && npx playwright-core install chromium
//   npm run site && node site/tools/capture.mjs [still] [og] [icons] [shots]
// CHROMIUM=/path/to/chrome overrides the browser; PLAYWRIGHT_CORE=/path/to/playwright-core the module.
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(SITE, "dist");
const ASSETS = join(SITE, "assets");
const PORT = 4963;
const jobs = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ["still", "og", "icons", "shots"]);

if (!existsSync(join(DIST, "index.html"))) {
  console.error("site/dist is missing: run `npm run site` first.");
  process.exit(1);
}

const { chromium } = await import(process.env.PLAYWRIGHT_CORE ? pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href : "playwright-core");

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };
const server = createServer((req, res) => {
  let p = join(DIST, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  if (!p.startsWith(DIST)) return void res.writeHead(403).end();
  if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
  if (!existsSync(p)) return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream" });
  res.end(readFileSync(p));
});
await new Promise((ok) => server.listen(PORT, "127.0.0.1", ok));
const URL_ = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {}) });

/** PNG bytes -> WebP bytes at `width`, encoded by Chromium's canvas. */
async function toWebp(png, width, quality = 0.86) {
  const page = await browser.newPage();
  const b64 = await page.evaluate(
    async ({ src, width, quality }) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      const w = Math.min(width, img.naturalWidth);
      const h = Math.round((img.naturalHeight * w) / img.naturalWidth);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(img, 0, 0, w, h);
      return c.toDataURL("image/webp", quality).split(",")[1];
    },
    { src: `data:image/png;base64,${png.toString("base64")}`, width, quality },
  );
  await page.close();
  return Buffer.from(b64, "base64");
}

async function officePage(viewport, dpr) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: dpr, reducedMotion: "no-preference" });
  await page.goto(URL_);
  await page.waitForFunction(() => window.__agentOffice?.running, null, { timeout: 15_000 });
  return page;
}

if (jobs.has("still")) {
  const page = await officePage({ width: 1440, height: 900 }, 2);
  // past the opening flip and its punch-in: the whole office, everyone at a desk
  await page.waitForTimeout(10_500);
  const png = await page.locator("#office").screenshot();
  writeFileSync(join(ASSETS, "office-still.webp"), await toWebp(png, 1800, 0.8));
  await page.close();
  console.log("assets/office-still.webp");
}

if (jobs.has("og")) {
  const page = await officePage({ width: 1200, height: 630 }, 1);
  await page.addStyleTag({
    content: `
      body::after, .nav, .kicker, .hero-more, .look, .statusbar, .tools, .sec, .foot, .copied, .sign-copy { display: none !important; }
      html, body { overflow: hidden !important; }
      .stage { grid-template-columns: 420px minmax(0, 1fr) !important; grid-template-areas: "hero office" !important; grid-template-rows: 630px !important; column-gap: 30px !important; padding: 0 34px !important; }
      .hero { display: flex !important; flex-direction: column !important; justify-content: center !important; padding: 0 !important; }
      .office-col { padding: 30px 0 !important; }
      .window { position: static !important; aspect-ratio: auto !important; max-height: none !important; height: 570px !important; }
      .wordmark .px { --s: 8px !important; }
      .tagline { font-size: 21px !important; margin: 26px 0 30px !important; }
    `,
  });
  // the opening table flip, after the camera has pulled back out and while the kaomoji is still up
  await page.evaluate(() => new Promise((ok) => window.__agentOffice.onEvent((e) => e.kind === "test_fail" && ok())));
  await page.waitForTimeout(3_400);
  await page.screenshot({ path: join(ASSETS, "og.png") });
  await page.close();
  console.log("assets/og.png");
}

if (jobs.has("icons")) {
  for (const [name, size] of [["favicon-32.png", 32], ["apple-touch-icon.png", 180]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(`<style>html,body{margin:0;background:#0b0a13}img{display:block;width:${size}px;height:${size}px}</style><img src="${URL_}favicon.svg">`);
    await page.waitForFunction(() => document.querySelector("img")?.complete);
    await page.screenshot({ path: join(ASSETS, name) });
    await page.close();
    console.log(`assets/${name}`);
  }
}

if (jobs.has("shots")) {
  const src = join(SITE, "tools/shots");
  mkdirSync(join(ASSETS, "shots"), { recursive: true });
  for (const f of readdirSync(src).filter((f) => f.endsWith(".png"))) {
    const png = readFileSync(join(src, f));
    const base = f.replace(/-1440\.png$/, "").replace(/\.png$/, "");
    for (const w of [1440, 960]) {
      writeFileSync(join(ASSETS, "shots", `${base}-${w}.webp`), await toWebp(png, w, 0.88));
      console.log(`assets/shots/${base}-${w}.webp`);
    }
  }
}

await browser.close();
server.close();
