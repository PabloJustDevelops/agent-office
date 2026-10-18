// Builds the landing page (site/) into site/dist, a static folder for any host.
//
//   node scripts/build-site.mjs           build once (npm run site)
//   node scripts/build-site.mjs --dev     build, serve on 127.0.0.1:4950 and rebuild + reload on change (npm run site:dev)
//
// The page reuses the office itself: the pixel font, glyphs, brand mark and palette are read from
// web/scene and web/ui at build time (with tiny stubs for their canvas and DOM helpers) and turned
// into inline SVG and CSS variables; the live hero bundles web/scene, src/demo and
// src/server/state.ts for the browser, with node built-ins aliased to site/shims/node.ts.
// SITE_URL=https://example.com makes og:image, og:url and the canonical link absolute.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "dist");
const DEV = process.argv.includes("--dev");
const SITE_URL = (process.env.SITE_URL ?? "").replace(/\/+$/, "");
const PORTS = [4950, 4999];

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
    export { icon, glyph, mark } from ${JSON.stringify(join(ROOT, "web/ui/icons.ts"))};
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

let gradId = 0;
/** One inline SVG per word, so pixel headings wrap like text. */
function pixelText(font, text, { grad = false, shadow = true } = {}) {
  const words = text.split(/ +/);
  const sized = words.map((w) => ({ w, ...textPixels(font, w) }));
  const space = font.glyphs.get(" ").adv;
  const total = sized.reduce((n, s) => n + s.w, 0) + space * (sized.length - 1);
  let off = 0;
  const id = `pxg${gradId++}`;
  return sized
    .map((s, i) => {
      const W = s.w + (shadow ? 1 : 0), H = font.cellH + (shadow ? 1 : 0);
      const d = runsPath(s.pts);
      const gid = `${id}-${i}`;
      const defs = grad
        ? `<defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="${-off}" y1="0" x2="${total - off}" y2="0"><stop offset="0" class="ga"/><stop offset="1" class="gb"/></linearGradient></defs>`
        : "";
      off += s.w + space;
      const sh = shadow ? `<path class="px-sh" transform="translate(1 1)" d="${d}"/>` : "";
      return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" style="--w:${W};--h:${H}" shape-rendering="crispEdges" focusable="false">${defs}${sh}<path class="px-fg"${grad ? ` style="fill:url(#${gid})"` : ""} d="${d}"/></svg>`;
    })
    .join(" ");
}

const LAYER = { a: "claude", b: "cc", c: "codex", "*": "cursor", "+": "dim", r: "red" };
function pixelArt(rows, cls) {
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
  const paths = [...layers].map(([ch, pts]) => `<path${ch === "#" ? "" : ` class="px-${LAYER[ch] ?? "dim"}"`} d="${runsPath(pts)}"/>`).join("");
  return `<svg class="${cls}" viewBox="0 0 ${w} ${rows.length}" width="${w * 2}" height="${rows.length * 2}" fill="currentColor" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/** The brand mark as a standalone SVG file (the favicon), colours inlined. */
function markFile(rows) {
  const fills = { "#": "#ECEAE4", a: "#D97757", b: "#F2F2F2", c: "#10A37F", "*": "#ECEAE4" };
  const w = Math.max(...rows.map((r) => r.length));
  const pad = 1, W = w + pad * 2, H = rows.length + pad * 2 + (w - rows.length);
  const oy = pad + Math.floor((w - rows.length) / 2);
  const layers = new Map();
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === "." || ch === " ") return;
    if (!layers.has(ch)) layers.set(ch, []);
    layers.get(ch).push([x + pad, y + oy]);
  }));
  const paths = [...layers].map(([ch, pts]) => `<path fill="${fills[ch] ?? "#ECEAE4"}" d="${runsPath(pts)}"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges"><rect width="${W}" height="${H}" rx="2" fill="#0b0a13"/><rect x="${pad + 1}" y="${oy + 1}" width="${w - 2}" height="${rows.length - 3}" fill="#0b0c0f"/>${paths}</svg>\n`;
}

/** assets/logos/<name>.svg as a <symbol>: the root's presentation attributes move onto a <g>. */
function logoSymbol(name) {
  const src = readFileSync(join(ROOT, "assets/logos", `${name}.svg`), "utf8")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
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

/* ------------------------------------------------------------------ page */

function attrsOf(s) {
  const out = {};
  for (const m of s.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) out[m[1]] = m[2] ?? true;
  return out;
}

async function page() {
  const d = await officeData();
  const font = d.FONT();
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const usedLogos = new Set();
  const colour = (n) => d.BRAND[n]?.color ?? d.HOST_BRAND[n]?.color ?? "currentColor";
  let html = readFileSync(join(SITE, "index.html"), "utf8");

  html = html
    .replace(/<px-text([^>]*)>([\s\S]*?)<\/px-text>/g, (_, a, text) => {
      const at = attrsOf(a);
      const t = unesc(text.trim());
      const svgs = pixelText(font, t, { grad: at.grad === true, shadow: at.flat !== true });
      const sr = at.decorative ? "" : `<span class="sr-only">${esc(t)}</span>`;
      return `${sr}<span class="px${at.class ? ` ${at.class}` : ""}" aria-hidden="true">${svgs}</span>`;
    })
    .replace(/<i-logo([^>]*)><\/i-logo>/g, (_, a) => {
      const at = attrsOf(a);
      usedLogos.add(at.n);
      const label = at.label ? ` role="img" aria-label="${esc(at.label)}"` : ` aria-hidden="true"`;
      return `<svg class="logo${at.class ? ` ${at.class}` : ""}" style="--c:${at.c ?? colour(at.n)}"${label} focusable="false"><use href="#lg-${at.n}"/></svg>`;
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

  // the palette, straight from the scene, as CSS variables
  const vars = [
    ...Object.entries(d.C).filter(([, v]) => typeof v === "string" && v.startsWith("#")).map(([k, v]) => `--c-${k}:${v}`),
    ...Object.entries(d.BRAND).map(([k, v]) => `--b-${k}:${v.color}`),
    ...Object.entries(d.HOST_BRAND).map(([k, v]) => `--h-${k}:${v.color}`),
  ];
  return { html, vars: `:root{${vars.join(";")}}\n`, favicon: markFile(d.mark().rows) };
}

/* ------------------------------------------------------------------ build */

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 10);
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
  const jsName = relative(OUT, join(ROOT, entry));

  if (existsSync(join(SITE, "assets"))) cpSync(join(SITE, "assets"), join(OUT, "assets"), { recursive: true });
  const { html: tpl, vars, favicon } = await page();
  const css = (await build({
    stdin: { contents: vars + readFileSync(join(SITE, "styles.css"), "utf8"), loader: "css", resolveDir: SITE },
    write: false,
    bundle: true,
    minify: !DEV,
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
  const rows = [["index.html", join(OUT, "index.html")], [cssName, join(OUT, cssName)], ...outputs.filter((o) => o.endsWith(".js")).map((o) => [relative(OUT, join(ROOT, o)), join(ROOT, o)])];
  let total = 0;
  for (const [name, p] of rows) {
    const s = size(p);
    total += s.gz;
    console.log(`  ${name.padEnd(36)} ${kb(s.raw).padStart(10)}  ${kb(s.gz).padStart(9)} gz`);
  }
  console.log(`  ${"html + css + js".padEnd(36)} ${"".padStart(10)}  ${kb(total).padStart(9)} gz`);
  if (!SITE_URL && !DEV) console.log("  note: SITE_URL is not set, so og:image is relative; set it for production (see site/README.md)");
  console.log(`site built in ${Date.now() - t0} ms -> ${relative(ROOT, OUT)}/`);
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
  let port = Number(process.env.PORT) || PORTS[0];
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && port < PORTS[1]) server.listen(++port, "127.0.0.1");
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
  for (const dir of ["site", "web/scene", "web/ui", "src/demo", "src/server", "src/shared", "assets"]) {
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) continue;
    watch(abs, { recursive: true }, (_, file) => {
      if (file && /(^|[\\/])dist([\\/]|$)/.test(String(file))) return;
      again();
    });
  }
}
