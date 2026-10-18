// Builds the landing page (site/) into site/dist, a static folder for any host.
//
//   node scripts/build-site.mjs           build once (npm run site)
//   node scripts/build-site.mjs --dev     build, serve on 127.0.0.1:5040 and rebuild + reload on change (npm run site:dev)
//
// No framework: esbuild for the TypeScript and the CSS, and the live office is site/office.ts, which
// bundles the app's own scene (web/scene), demo (src/demo) and state (src/server/state.ts) for the
// browser, with node built-ins aliased to site/shims/node.ts. The bitmap font, brand mark, pixel
// glyphs, palette and agent colours are read from web/scene, web/ui and src/shared at build time and
// inlined as SVG, so the page and the office stay one thing.
//
//   SITE_URL=https://example.com   makes og:image, og:url and the canonical link absolute
//   GITHUB_STARS=<n>               the star count, instead of asking the GitHub API ("" hides it)
//   STARS_MIN=<n>                  hide the count below this many stars (default 50)
//   TOUR_VIDEO=<path>              the launch video (.mp4 or .webm); site/assets/tour.{mp4,webm} is
//                                  picked up on its own. With neither, the "watch the tour" button and
//                                  its player are left out of the page.
//   SITE_OUT=<dir>                 build somewhere other than site/dist
//   PORT=<n>                       the dev server's port (default: the first free one from 5040)
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = resolve(process.env.SITE_OUT || join(SITE, "dist"));
const DEV = process.argv.includes("--dev");
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const REPO = "bas3line/agent-office";
const STARS_MIN = Number(process.env.STARS_MIN ?? 50);
/** The dev server takes the first free port in 5040-5049 unless PORT says otherwise. */
const PORTS = [5040, 5049];

/* ------------------------------------------------------------------ office data */

// font.ts draws its glyph atlas into a canvas from util.ts, icons.ts builds SVG through dom.ts:
// in node both get a stub that records the pixels instead.
const STUBS = {
  util: `
    export function bitmap(w, h) {
      const px = new Set();
      return { w, h, c: { px }, g: { fillStyle: "", globalCompositeOperation: "", fillRect(x, y, fw, fh) { for (let j = 0; j < fh; j++) for (let i = 0; i < fw; i++) px.add((x + i) + "," + (y + j)); }, drawImage() {} } };
    }`,
  dom: `export function pixels(rows, scale, cls) { return { rows, cls }; }`,
};

async function officeData() {
  const entry = `
    export { FONT } from ${JSON.stringify(join(ROOT, "web/scene/font.ts"))};
    export { glyph, icon, mark } from ${JSON.stringify(join(ROOT, "web/ui/icons.ts"))};
    export { C } from ${JSON.stringify(join(ROOT, "web/scene/palette.ts"))};
    export { BRAND, HOST_BRAND } from ${JSON.stringify(join(ROOT, "src/shared/events.ts"))};`;
  const res = await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "js" },
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent",
    plugins: [
      {
        name: "stubs",
        setup(b) {
          b.onResolve({ filter: /^\.\/util\.ts$/ }, (a) => (a.importer.endsWith("font.ts") ? { path: "util", namespace: "stub" } : undefined));
          b.onResolve({ filter: /^\.\/dom\.ts$/ }, (a) => (a.importer.endsWith("icons.ts") ? { path: "dom", namespace: "stub" } : undefined));
          b.onLoad({ filter: /.*/, namespace: "stub" }, (a) => ({ contents: STUBS[a.path], loader: "js" }));
        },
      },
    ],
  });
  const code = res.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}#${Date.now()}`);
}

/* ------------------------------------------------------------------ svg helpers */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const unesc = (s) => s.replace(/&apos;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** Horizontal runs of a pixel set as one path. */
function runsPath(points) {
  const rows = new Map();
  for (const [x, y] of points) {
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(x);
  }
  let d = "";
  for (const [y, xs] of [...rows].sort((a, b) => a[0] - b[0])) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i < xs.length; ) {
      let j = i;
      while (j + 1 < xs.length && xs[j + 1] === xs[j] + 1) j++;
      d += `M${xs[i]} ${y}h${j - i + 1}v1h${i - j - 1}z`;
      i = j + 1;
    }
  }
  return d;
}

/** Pixel rows as an inline SVG at an integer scale: "#" is currentColor, any other letter its own classed layer. */
function pixelArt(rows, cls, scale = 2) {
  const layers = new Map();
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === "." || ch === " ") continue;
      if (!layers.has(ch)) layers.set(ch, []);
      layers.get(ch).push([x, y]);
    }
  });
  const w = Math.max(...rows.map((r) => r.length));
  const paths = [...layers].map(([ch, pts]) => `<path${ch === "#" ? "" : ` class="px-${/[a-z]/.test(ch) ? ch : "x"}"`} d="${runsPath(pts)}"/>`).join("");
  return `<svg class="${cls}" viewBox="0 0 ${w} ${rows.length}" width="${w * scale}" height="${rows.length * scale}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function textPixels(font, text) {
  const px = font.atlas.c.px;
  const pts = [];
  let cx = 0;
  for (const ch of text) {
    const gl = font.glyphs.get(ch) ?? font.glyphs.get("?");
    for (let y = 0; y < font.cellH; y++) for (let x = 0; x < gl.w; x++) if (px.has(`${gl.ax + x},${y}`)) pts.push([cx + x, y]);
    cx += gl.adv;
  }
  return { pts, w: Math.max(1, cx - font.gap) };
}

/**
 * Text in the office's bitmap font: one SVG per word so it wraps like text. --w and --h carry the
 * size in font pixels, so CSS can scale it by an integer (or by the em, where crispness can give).
 */
let gradId = 0;
function pixelText(font, text, { grad = false } = {}) {
  const words = text.split(/ +/);
  return words
    .map((word) => {
      const { pts, w } = textPixels(font, word);
      const id = `pxg${gradId++}`;
      // a vertical gradient in font pixels, coloured by CSS (.ga / .gb)
      const defs = grad ? `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${font.cellH}"><stop offset="0" class="ga"/><stop offset="1" class="gb"/></linearGradient></defs>` : "";
      return `<svg viewBox="0 0 ${w} ${font.cellH}" width="${w}" height="${font.cellH}" style="--w:${w};--h:${font.cellH}" shape-rendering="crispEdges" fill="currentColor" focusable="false">${defs}<path${grad ? ` fill="url(#${id})"` : ""} d="${runsPath(pts)}"/></svg>`;
    })
    .join(" ");
}

/** A deterministic random stream for the build's generated art. */
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/**
 * The footer's night skyline, in the office's own sky colours: two rows of towers, sparse lit
 * windows (a few of them twinkle) and stars. 640 x 100 art pixels, drawn at an integer scale.
 */
function skyline(C) {
  const W = 640, H = 100, r = rng(42);
  const layer = (base, minH, maxH, minW, maxW, fill, lit, cls) => {
    const towers = [];
    let x = -4;
    while (x < W) {
      const w = Math.round(minW + r() * (maxW - minW));
      const h = Math.round(minH + r() * (maxH - minH));
      towers.push({ x, w, h });
      x += w + (r() < 0.3 ? 2 : 0);
    }
    let d = "", win = "", tw = "";
    for (const t of towers) {
      const top = base - t.h;
      d += `M${t.x} ${top}h${t.w}v${H - top}h${-t.w}z`;
      if (r() < 0.25 && t.w > 8) d += `M${t.x + Math.floor(t.w / 2)} ${top - 4}h1v4h-1z`;
      for (let wy = top + 3; wy < H - 4; wy += 3)
        for (let wx = t.x + 2; wx < t.x + t.w - 2; wx += 3) {
          const p = r();
          if (p < lit) {
            const rect = `M${wx} ${wy}h1v1h-1z`;
            if (p < lit * 0.12) tw += rect;
            else win += rect;
          }
        }
    }
    return `<path class="${cls}" fill="${fill}" d="${d}"/><path class="win" d="${win}"/><path class="win tw" d="${tw}"/>`;
  };
  let stars = "";
  for (let i = 0; i < 90; i++) stars += `M${Math.floor(r() * W)} ${Math.floor(r() * 46)}h1v1h-1z`;
  const far = layer(H, 26, 62, 10, 26, C.blue2, 0.05, "far");
  const near = layer(H, 10, 40, 12, 30, C.blue1, 0.09, "near");
  return `<svg class="skyline" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMidYMax meet" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><path class="stars" d="${stars}"/>${far}${near}</svg>`;
}

/** The brand mark as a standalone SVG file (the favicon): monochrome, one line in the accent. */
function markFile(rows) {
  const fills = { "#": "#EDEDED", a: "#8E75FF", b: "#8F8F8F", c: "#8F8F8F", "*": "#EDEDED" };
  const w = Math.max(...rows.map((r) => r.length));
  const pad = 1, W = w + pad * 2, H = rows.length + pad * 2 + (w - rows.length);
  const oy = pad + Math.floor((w - rows.length) / 2);
  const layers = new Map();
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === "." || ch === " ") return;
    if (!layers.has(ch)) layers.set(ch, []);
    layers.get(ch).push([x + pad, y + oy]);
  }));
  const paths = [...layers].map(([ch, pts]) => `<path fill="${fills[ch] ?? "#EDEDED"}" d="${runsPath(pts)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" rx="2" fill="#0A0A0A"/>${paths}</svg>\n`;
}

/** assets/logos/<name>.svg as a <symbol>: the root's presentation attributes move onto a <g>. */
function logoSymbol(name) {
  const src = readFileSync(join(ROOT, "assets/logos", `${name}.svg`), "utf8")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<metadata>[\s\S]*?<\/metadata>/g, "");
  const open = /<svg\b([^>]*)>/.exec(src);
  const attrs = open[1];
  const inner = src.slice(open.index + open[0].length, src.lastIndexOf("</svg>")).trim();
  const get = (k) => new RegExp(`\\s${k}="([^"]*)"`).exec(attrs)?.[1];
  const keep = ["fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"]
    .map((k) => (get(k) ? ` ${k}="${get(k)}"` : ""))
    .join("");
  return `<symbol id="lg-${name}" viewBox="${get("viewBox") ?? "0 0 24 24"}"><g${keep || ' fill="currentColor"'}>${inner}</g></symbol>`;
}

/** Relative luminance of #rrggbb, to tell which brand colours vanish on a white page. */
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/* ------------------------------------------------------------------ github stars */

let starsCache;
async function stars() {
  if (process.env.GITHUB_STARS !== undefined) return process.env.GITHUB_STARS === "" ? null : Number(process.env.GITHUB_STARS);
  if (starsCache !== undefined) return starsCache;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "agent-office-site" },
      signal: AbortSignal.timeout(4000),
    });
    starsCache = res.ok ? Number((await res.json()).stargazers_count) : null;
  } catch {
    starsCache = null;
  }
  if (starsCache === null) console.log("  note: couldn't read the star count from GitHub, so the page shows none (GITHUB_STARS=<n> sets it)");
  return starsCache;
}
const short = (n) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(n));

/* ------------------------------------------------------------------ the tour video */

function tourVideo() {
  const cands = [process.env.TOUR_VIDEO, join(SITE, "assets/tour.mp4"), join(SITE, "assets/tour.webm")].filter(Boolean);
  const file = cands.find((f) => existsSync(f) && statSync(f).isFile());
  if (!file) return null;
  const ext = extname(file).toLowerCase();
  if (ext !== ".mp4" && ext !== ".webm") throw new Error(`site: TOUR_VIDEO must be .mp4 or .webm, not ${ext}`);
  const poster = ["tour-poster.webp", "tour-poster.jpg"].map((p) => join(dirname(file), p)).find((p) => existsSync(p));
  return { file, name: `tour${ext}`, type: ext === ".mp4" ? "video/mp4" : "video/webm", seconds: ext === ".mp4" ? mp4Seconds(file) : null, poster };
}

/** The duration in an mp4's mvhd box (in its first 4 MB), for the button's "40-second" label. */
function mp4Seconds(file) {
  const fd = openSync(file, "r");
  const buf = Buffer.alloc(Math.min(statSync(file).size, 4 << 20));
  readSync(fd, buf, 0, buf.length, 0);
  closeSync(fd);
  const i = buf.indexOf("mvhd");
  if (i < 0) return null;
  const v = buf[i + 4];
  const scale = v === 1 ? buf.readUInt32BE(i + 24) : buf.readUInt32BE(i + 16);
  const dur = v === 1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20);
  return scale ? dur / scale : null;
}

/* ------------------------------------------------------------------ page */

function attrsOf(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? true;
  return out;
}

async function page(tour) {
  const d = await officeData();
  const font = d.FONT();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const usedLogos = new Set();
  const colour = (n) => d.BRAND[n]?.color ?? d.HOST_BRAND[n]?.color;
  let html = readFileSync(join(SITE, "index.html"), "utf8");

  html = html
    .replace(/<px-text([^>]*)>([\s\S]*?)<\/px-text>/g, (_, a, text) => {
      const at = attrsOf(a);
      const t = unesc(text.trim());
      const sr = at.decorative ? "" : `<span class="sr-only">${esc(t)}</span>`;
      return `${sr}<span class="px${at.class ? ` ${at.class}` : ""}" aria-hidden="true">${pixelText(font, t, { grad: at.grad === true })}</span>`;
    })
    .replace(/<i-skyline><\/i-skyline>/g, () => skyline(d.C))
    .replace(/<i-logo([^>]*)><\/i-logo>/g, (_, a) => {
      const at = attrsOf(a);
      usedLogos.add(at.n);
      const c = at.c ?? colour(at.n) ?? "currentColor";
      // near-white brand colours (Command Code, Cursor, Vercel) hover to the text colour on a light page
      const pale = c.startsWith("#") && luminance(c) > 0.7 ? " is-pale" : "";
      const label = at.label ? ` role="img" aria-label="${esc(at.label)}"` : ` aria-hidden="true"`;
      return `<svg class="logo${pale}${at.class ? ` ${at.class}` : ""}" style="--c:${c}"${label} focusable="false"><use href="#lg-${at.n}"/></svg>`;
    })
    .replace(/<i-glyph([^>]*)><\/i-glyph>/g, (_, a) => {
      const at = attrsOf(a);
      const r = d.glyph(at.n);
      if (!r?.rows) throw new Error(`site: no glyph "${at.n}" in web/ui/icons.ts`);
      return pixelArt(r.rows, `glyph${at.class ? ` ${at.class}` : ""}`);
    })
    .replace(/<i-icon([^>]*)><\/i-icon>/g, (_, a) => {
      const at = attrsOf(a);
      const r = d.icon(at.n);
      if (!r?.rows) throw new Error(`site: no icon "${at.n}" in web/ui/icons.ts`);
      return pixelArt(r.rows, `icon${at.class ? ` ${at.class}` : ""}`);
    })
    .replace(/<i-mark([^>]*)><\/i-mark>/g, (_, a) => pixelArt(d.mark().rows, `mark${attrsOf(a).class ? ` ${attrsOf(a).class}` : ""}`));

  // a count of 1 reads weaker than none: below STARS_MIN the button is just "GitHub"
  const n = await stars();
  html = n === null || Number.isNaN(n) || n < STARS_MIN
    ? html.replace(/<!--stars-->[\s\S]*?<!--\/stars-->/g, "").replaceAll("{{gh-label}}", "GitHub")
    : html.replace(/<!--\/?stars-->/g, "").replaceAll("{{stars}}", esc(short(n))).replaceAll("{{gh-label}}", `GitHub, ${n} stars`);

  if (tour) {
    const secs = tour.seconds ? (tour.seconds > 20 ? Math.round(tour.seconds / 5) * 5 : Math.round(tour.seconds)) : null;
    html = html
      .replace(/<!--\/?tour-->/g, "")
      .replaceAll("{{tour-label}}", secs ? `Watch the ${secs}-second tour` : "Watch the tour")
      .replaceAll("{{tour-src}}", `assets/${tour.name}`)
      .replaceAll("{{tour-type}}", tour.type)
      .replaceAll("{{tour-poster}}", tour.poster ? ` poster="assets/${relative(dirname(tour.file), tour.poster)}"` : "");
  } else {
    html = html.replace(/<!--tour-->[\s\S]*?<!--\/tour-->/g, "");
  }

  const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>${[...usedLogos].map(logoSymbol).join("")}</defs></svg>`;
  const abs = (p) => (SITE_URL ? `${SITE_URL}/${p}` : p);
  html = html
    .replace("<!--logo-sprite-->", sprite)
    .replaceAll("{{version}}", esc(pkg.version))
    .replaceAll("{{url}}", esc(SITE_URL ? `${SITE_URL}/` : ""))
    .replace(/\{\{abs:([^}]+)\}\}/g, (_, p) => esc(abs(p.trim())))
    .replace(/[ \t]*<link rel="canonical" href="">\n?/, "")
    .replace(/[ \t]*<meta property="og:url" content="">\n?/, "");
  if (DEV) html = html.replace("</body>", `<script>new EventSource("/__reload").onmessage = () => location.reload();</script>\n</body>`);
  return { html, favicon: markFile(d.mark().rows) };
}

/* ------------------------------------------------------------------ build */

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
// the office's state module imports node built-ins it never calls in the browser: the shims stand in
const nodeShim = {
  name: "node-shim",
  setup(b) {
    b.onResolve({ filter: /^node:/ }, () => ({ path: join(SITE, "shims/node.ts") }));
  },
};

async function buildSite() {
  const t0 = Date.now();
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, "assets"), { recursive: true });

  const js = await build({
    entryPoints: [join(SITE, "main.ts")],
    outdir: join(OUT, "assets"),
    entryNames: "[name]-[hash]",
    chunkNames: "[name]-[hash]",
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: !DEV,
    sourcemap: DEV ? "inline" : false,
    metafile: true,
    legalComments: "none",
    loader: { ".svg": "text" },
    plugins: [nodeShim],
    logLevel: "warning",
  });
  const outputs = Object.keys(js.metafile.outputs);
  const entry = outputs.find((o) => js.metafile.outputs[o].entryPoint?.endsWith("site/main.ts"));
  const jsName = relative(OUT, resolve(process.cwd(), entry));

  // the tour video is copied on its own (below), never as part of assets/
  if (existsSync(join(SITE, "assets"))) cpSync(join(SITE, "assets"), join(OUT, "assets"), { recursive: true, filter: (src) => !/[\\/]tour\.(mp4|webm)$/.test(src) });
  const tour = tourVideo();
  if (tour) {
    cpSync(tour.file, join(OUT, "assets", tour.name));
    if (tour.poster) cpSync(tour.poster, join(OUT, "assets", relative(dirname(tour.file), tour.poster)));
  }
  const { html: tpl, favicon } = await page(tour);
  const css = (await build({
    stdin: { contents: readFileSync(join(SITE, "styles.css"), "utf8"), loader: "css", resolveDir: SITE },
    write: false,
    bundle: true,
    minify: !DEV,
    // url()s point at files next to the stylesheet in dist/assets
    external: ["*.webp", "*.png", "*.jpg", "*.svg"],
    logLevel: "warning",
  })).outputFiles[0].text;
  const cssName = `assets/site-${hash(css)}.css`;
  writeFileSync(join(OUT, cssName), css);
  writeFileSync(join(OUT, "favicon.svg"), favicon);
  writeFileSync(join(OUT, "index.html"), tpl.replace("{{css}}", cssName).replace("{{js}}", jsName));
  writeFileSync(join(OUT, ".nojekyll"), "");

  const size = (p) => {
    const b = readFileSync(p);
    return { raw: b.length, gz: gzipSync(b, { level: 9 }).length };
  };
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  const rows = [["index.html", join(OUT, "index.html")], [cssName, join(OUT, cssName)], ...outputs.filter((o) => o.endsWith(".js")).map((o) => [relative(OUT, resolve(process.cwd(), o)), resolve(process.cwd(), o)])];
  let total = 0;
  for (const [name, p] of rows) {
    const s = size(p);
    total += s.gz;
    console.log(`  ${name.padEnd(36)} ${kb(s.raw).padStart(10)}  ${kb(s.gz).padStart(9)} gz`);
  }
  console.log(`  ${"html + css + js".padEnd(36)} ${"".padStart(10)}  ${kb(total).padStart(9)} gz`);
  console.log(`  tour video: ${tour ? `${relative(ROOT, tour.file)}${tour.seconds ? ` (${tour.seconds.toFixed(1)} s)` : ""}` : "none, so the page leaves the button out"}`);
  if (!SITE_URL && !DEV) console.log("  note: SITE_URL is not set, so og:image is relative; set it for production");
  console.log(`site built in ${Date.now() - t0} ms -> ${relative(ROOT, OUT) || OUT}/`);
}

/* ------------------------------------------------------------------ dev server */

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".json": "application/json", ".txt": "text/plain", ".ico": "image/x-icon", ".mp4": "video/mp4", ".webm": "video/webm" };

function serve() {
  const clients = new Set();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__reload") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      res.write(": hi\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    let p = join(OUT, decodeURIComponent(url.pathname));
    if (!p.startsWith(OUT)) return void res.writeHead(403).end();
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    if (!existsSync(p)) return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    res.writeHead(200, { "content-type": TYPES[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(p));
  });
  // PORT is taken as given (and fails if it's busy); without it, the first free port in the range
  const want = Number(process.env.PORT);
  const fixed = Number.isInteger(want) && want > 0 && want < 65536;
  let port = fixed ? want : PORTS[0];
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && !fixed && port < PORTS[1]) server.listen(++port, "127.0.0.1");
    else throw err;
  });
  server.on("listening", () => console.log(`site: http://127.0.0.1:${port}/  (pid ${process.pid}, watching for changes)`));
  server.listen(port, "127.0.0.1");
  return () => {
    for (const c of clients) c.write("data: reload\n\n");
  };
}

await buildSite();
if (DEV) {
  const reload = serve();
  let timer;
  let busy = false;
  const again = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (busy) return again();
      busy = true;
      try {
        await buildSite();
        reload();
      } catch (err) {
        console.error(err.message ?? err);
      }
      busy = false;
    }, 120);
  };
  const WATCH = { site: null, "web/scene": null, "web/ui": null, "src/demo": null, "src/server": null, "src/shared": null, "assets/logos": null };
  for (const [dir, only] of Object.entries(WATCH)) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    watch(abs, { recursive: true }, (_, file) => {
      const f = String(file ?? "");
      if (/(^|[\\/])dist([\\/]|$)/.test(f)) return;
      if (only && !only.test(f)) return;
      again();
    });
  }
}
