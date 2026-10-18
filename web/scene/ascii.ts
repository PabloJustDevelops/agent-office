/*
 * ASCII mode. The scene renders a clean copy of the office for this pass
 * (flat ground, outlines, no lighting), sampled here at 2x3 points per
 * character cell. Those six values are a shape vector; the glyph whose own
 * 2x3 coverage (measured from the scene's 5x7 font) is nearest wins, so
 * edges become / | _ - and solid things become dense glyphs, instead of every
 * cell getting a brightness-ramp character. Cells close to the ground colour
 * stay blank, which keeps floors and walls clean and lets people, desks and
 * screens carry the picture. Each glyph takes the most vivid colour in its
 * cell, brightened, so brand colours stay true. A quantized lookup table
 * caches the nearest-glyph search. Hairline and corner glyphs (synthetic,
 * not in the font) let outlines join into clean boxes, and edges are
 * emphasised over flat fills. People are not converted at all: the scene
 * hands in glyph figures (see figures.ts) stamped onto the grid last.
 * Everything is written into one ImageData; `amount` < 1 dissolves cell by
 * cell for the mode transition.
 */
import { FONT } from "./font.ts";
import { bitmap, ctx2d, hash, makeCanvas, type Bitmap } from "./util.ts";

// symbols only: letters in the fill read as words, not shapes
const CHARS = " .,:;'`-_~=+*^!|/\\()<>[]{}\"#%@&$o0x─";
const CW = 6, CH = 10;
const SX = 2, SY = 3;
const Q = 8;

interface GlyphSet { chars: string[]; vec: Float32Array[]; masks: number[][] }

/** A glyph figure stamped on top of the converted picture (workers). */
export interface Figure {
  /** cell of the figure's top-left */
  col: number;
  row: number;
  rows: string[];
  /** a colour per character (hex), parallel to rows */
  colors: string[][];
}

let atlasPx: Uint8ClampedArray | null = null;
/** The font atlas, read back once (a second readback trips Chrome's willReadFrequently warning). */
function atlasPixels(): Uint8ClampedArray {
  const f = FONT();
  return (atlasPx ??= f.atlas.g.getImageData(0, 0, f.atlas.w, f.atlas.h).data);
}
const maskCache = new Map<string, number[]>();

/**
 * Box-drawing and shade glyphs for the stamped furniture, drawn straight into the 6x10 cell so
 * lines run edge to edge and join their neighbours (the font's glyphs leave a gap between rows).
 */
function boxMask(ch: string): number[] | null {
  const H = (y: number, x0 = 0, x1 = CW - 1) => Array.from({ length: x1 - x0 + 1 }, (_, i) => y * CW + x0 + i);
  const V = (x: number, y0 = 0, y1 = CH - 1) => Array.from({ length: y1 - y0 + 1 }, (_, i) => (y0 + i) * CW + x);
  const mx = 2, my = 5;
  switch (ch) {
    case "─": return H(my);
    case "│": return V(mx);
    case "┌": return [...H(my, mx), ...V(mx, my)];
    case "┐": return [...H(my, 0, mx), ...V(mx, my)];
    case "└": return [...V(mx, 0, my), ...H(my, mx)];
    case "┘": return [...V(mx, 0, my), ...H(my, 0, mx)];
    case "┬": return [...H(my), ...V(mx, my)];
    case "┴": return [...H(my), ...V(mx, 0, my)];
    case "═": return [...H(my - 1), ...H(my + 1)];
    case "║": return [...V(mx - 1), ...V(mx + 1)];
    case "╔": return [...H(my - 1, mx - 1), ...H(my + 1, mx + 1), ...V(mx - 1, my - 1), ...V(mx + 1, my + 1)];
    case "╗": return [...H(my - 1, 0, mx + 1), ...H(my + 1, 0, mx - 1), ...V(mx + 1, my - 1), ...V(mx - 1, my + 1)];
    case "╚": return [...H(my + 1, mx - 1), ...H(my - 1, mx + 1), ...V(mx - 1, 0, my + 1), ...V(mx + 1, 0, my - 1)];
    case "╝": return [...H(my + 1, 0, mx + 1), ...H(my - 1, 0, mx - 1), ...V(mx + 1, 0, my + 1), ...V(mx - 1, 0, my - 1)];
    case "╧": return [...H(my - 1), ...H(my + 1), ...V(mx, 0, my - 1)];
    case "█": return Array.from({ length: CW * CH }, (_, i) => i);
    case "▓": return Array.from({ length: CW * CH }, (_, i) => i).filter((i) => ((i % CW) + Math.floor(i / CW)) % 2 === 0 || (i % CW) % 3 === 0);
    case "▒": return Array.from({ length: CW * CH }, (_, i) => i).filter((i) => ((i % CW) + Math.floor(i / CW)) % 2 === 0);
    case "░": return Array.from({ length: CW * CH }, (_, i) => i).filter((i) => (i % CW) % 2 === 0 && Math.floor(i / CW) % 3 === 1);
    case "▀": return Array.from({ length: CW * 5 }, (_, i) => i);
    case "▄": return Array.from({ length: CW * 5 }, (_, i) => i + CW * 5);
    default: return null;
  }
}

/** Pixel offsets of any font glyph inside a cell (read once from the atlas). */
function maskOf(ch: string): number[] {
  let pts = maskCache.get(ch);
  if (pts) return pts;
  const box = boxMask(ch);
  if (box) {
    maskCache.set(ch, box);
    return box;
  }
  const f = FONT();
  const px = atlasPixels();
  const gl = f.glyphs.get(ch) ?? f.glyphs.get("?")!;
  pts = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < gl.w; x++) if (px[(y * f.atlas.w + gl.ax + x) * 4 + 3] > 128) pts.push((y + 1) * CW + x);
  maskCache.set(ch, pts);
  return pts;
}

const abgr = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return (0xff000000 | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0;
};

let glyphs: GlyphSet | null = null;
function glyphSet(): GlyphSet {
  if (glyphs) return glyphs;
  const f = FONT();
  const d = atlasPixels();
  const chars: string[] = [];
  const vec: Float32Array[] = [];
  const masks: number[][] = [];
  let peak = 0;
  for (const ch of CHARS) {
    const gl = f.glyphs.get(ch);
    if (!gl) continue;
    const pts: number[] = [];
    const cov = new Float32Array(SX * SY);
    // glyph rows 0..7 sit at cell rows 1..8; box glyphs are 6 wide and join
    for (let y = 0; y < 8; y++) for (let x = 0; x < gl.w; x++) {
      if (d[(y * f.atlas.w + gl.ax + x) * 4 + 3] <= 128) continue;
      const cx = x, cy = y + 1;
      pts.push(cy * CW + cx);
      const rx = Math.min(SX - 1, Math.floor((cx + 0.5) / (CW / SX)));
      const ry = Math.min(SY - 1, Math.floor((cy + 0.5) / (CH / SY)));
      cov[ry * SX + rx] += 1;
    }
    const area = (CW / SX) * (CH / SY);
    for (let i = 0; i < cov.length; i++) { cov[i] /= area; peak = Math.max(peak, cov[i]); }
    chars.push(ch);
    vec.push(cov);
    masks.push(pts);
  }
  // hairlines along each edge of the cell and through its centre, plus
  // corners: outlines of rugs, desks and walls join up into clean boxes
  const line = (ch: string, pts: [number, number][]) => {
    const cov = new Float32Array(SX * SY);
    const area = (CW / SX) * (CH / SY);
    for (const [x, y] of pts) cov[Math.min(SY - 1, Math.floor((y + 0.5) / (CH / SY))) * SX + Math.min(SX - 1, Math.floor((x + 0.5) / (CW / SX)))] += 1 / area;
    chars.push(ch);
    vec.push(cov);
    masks.push(pts.map(([x, y]) => y * CW + x));
  };
  const H = (y: number, x0 = 0, x1 = CW - 1) => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y] as [number, number]);
  const V = (x: number, y0 = 0, y1 = CH - 1) => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i] as [number, number]);
  line("▔", H(1));
  line("▁", H(8));
  line("│", V(2));
  line("▏", V(0));
  line("▕", V(5));
  // lines that straddle two sample rows / columns would otherwise match x or =
  line("\u2501", [...H(2), ...H(3)]);
  line("\u2509", [...H(6), ...H(7)]);
  line("┌", [...H(4, 2), ...V(2, 5)]);
  line("┐", [...H(4, 0, 2), ...V(2, 5)]);
  line("└", [...V(2, 0, 3), ...H(4, 2)]);
  line("┘", [...V(2, 0, 3), ...H(4, 0, 2)]);
  for (const v of vec) for (let i = 0; i < v.length; i++) v[i] /= peak;
  glyphs = { chars, vec, masks };
  return glyphs;
}

export class Ascii {
  private sample: Bitmap | null = null;
  private out: Bitmap | null = null;
  private img: ImageData | null = null;
  private u32: Uint32Array | null = null;
  private noise: Float32Array | null = null;
  private lut = new Int16Array(Q ** (SX * SY)).fill(-1);
  /** glyph pixel offsets inside a cell, for the current row stride */
  private offs: Int32Array[] = [];
  private figOffs = new Map<string, Int32Array>();
  /** auto-levels, eased across frames so the picture never pumps */
  private hi = 0.8;
  cols = 0;
  rows = 0;
  gp = 1;

  private ensure(w: number, h: number, dpr: number) {
    const gp = Math.max(1, Math.round(dpr));
    const cols = Math.ceil(w / (CW * gp)), rows = Math.ceil(h / (CH * gp));
    if (cols === this.cols && rows === this.rows && gp === this.gp && this.out) return;
    this.cols = cols; this.rows = rows; this.gp = gp;
    const sc = makeCanvas(cols * SX, rows * SY);
    this.sample = { c: sc, g: ctx2d(sc, { willReadFrequently: true }), w: cols * SX, h: rows * SY };
    this.out = bitmap(cols * CW, rows * CH);
    this.img = this.out.g.createImageData(cols * CW, rows * CH);
    this.u32 = new Uint32Array(this.img.data.buffer);
    this.noise = new Float32Array(cols * rows);
    const ow = cols * CW;
    this.offs = glyphSet().masks.map((m) => Int32Array.from(m, (o) => Math.floor(o / CW) * ow + (o % CW)));
    this.figOffs.clear();
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      this.noise[r * cols + c] = (hash(c + ":" + r) % 1000) / 1000 * 0.55 + (r / rows) * 0.45;
    }
  }

  private nearest(key: number, v: Float32Array): number {
    const hit = this.lut[key];
    if (hit >= 0) return hit;
    const gs = glyphSet();
    let best = 0, bd = Infinity;
    for (let i = 0; i < gs.vec.length; i++) {
      const gv = gs.vec[i];
      let d = 0;
      for (let k = 0; k < v.length; k++) { const e = gv[k] - v[k]; d += e * e; }
      if (d < bd) { bd = d; best = i; }
    }
    this.lut[key] = best;
    return best;
  }

  /**
   * Render ASCII onto `dst` (W x H device px). `sample` paints the source
   * into a (cols*2) x (rows*3) canvas, `cellW` x `cellH` device px per sample.
   */
  /** The glyph the matcher picks for a raw 2x3 shape vector (for tests). */
  glyphFor(v: number[]): string {
    const v6 = Float32Array.from(v);
    let key = 0;
    for (const q of v6) key = key * Q + Math.min(Q - 1, Math.floor(q * Q));
    return glyphSet().chars[this.nearest(key, v6)];
  }

  /** Cell size in device px for a canvas at this dpr. */
  cell(dpr: number) {
    const gp = Math.max(1, Math.round(dpr));
    return { w: CW * gp, h: CH * gp };
  }

  render(W: number, H: number, sample: (g: CanvasRenderingContext2D, w: number, h: number, cellW: number, cellH: number) => void, dst: CanvasRenderingContext2D, dpr: number, amount: number, _t: number, figures: Figure[] = []) {
    this.ensure(W, H, dpr);
    const s = this.sample!, out = this.out!, u32 = this.u32!, noise = this.noise!;
    const { cols, rows, gp } = this;
    const sw = cols * SX, sh = rows * SY;
    s.g.setTransform(1, 0, 0, 1, 0, 0);
    s.g.imageSmoothingEnabled = true;
    s.g.imageSmoothingQuality = "high";
    sample(s.g, sw, sh, (CW * gp) / SX, (CH * gp) / SY);
    const px = s.g.getImageData(0, 0, sw, sh).data;
    const offs = this.offs;
    const ow = cols * CW;
    const BG = 0xff0c0709; // abgr: #09070c
    const full = amount >= 0.999;
    u32.fill(full ? BG : 0);
    // ink per sample: how far it stands out from the ground (#0b0a13)
    const n = sw * sh;
    const ink = new Float32Array(n);
    const hist = new Uint32Array(64);
    for (let i = 0; i < n; i++) {
      const R = px[i * 4], G = px[i * 4 + 1], B = px[i * 4 + 2];
      const mx = Math.max(R, G, B), lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      const v = Math.max(0, (0.55 * lum + 0.45 * mx) / 255 - 0.06);
      ink[i] = v;
      if (v > 0.02) hist[Math.min(63, Math.floor(v * 64))]++;
    }
    // edges carry the drawing; flat interiors fade to light texture
    const blur = new Float32Array(n);
    const tmp = new Float32Array(n);
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      tmp[i] = (ink[i] + (x > 0 ? ink[i - 1] : ink[i]) + (x < sw - 1 ? ink[i + 1] : ink[i])) / 3;
    }
    for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
      const i = y * sw + x;
      blur[i] = (tmp[i] + (y > 0 ? tmp[i - sw] : tmp[i]) + (y < sh - 1 ? tmp[i + sw] : tmp[i])) / 3;
    }
    for (let i = 0; i < n; i++) {
      const e = Math.min(1, Math.abs(ink[i] - blur[i]) * 6);
      ink[i] *= 0.32 + 0.68 * e;
    }
    let tot = 0;
    for (let b = 0; b < 64; b++) tot += hist[b];
    let acc = 0, hi = 0.8;
    for (let b = 63; b >= 0; b--) { acc += hist[b]; if (acc >= tot * 0.04) { hi = (b + 1) / 64; break; } }
    this.hi += (Math.max(0.35, hi) - this.hi) * 0.12;
    const scale = 1 / this.hi;
    const v6 = new Float32Array(SX * SY);
    const gs = glyphSet();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const ci = r * cols + c;
        if (!full && noise[ci] > amount) continue;
        let m = 0, key = 0, best = -1, bestScore = -1;
        for (let yy = 0; yy < SY; yy++) for (let xx = 0; xx < SX; xx++) {
          const si = (r * SY + yy) * sw + c * SX + xx;
          const v = Math.min(1, ink[si] * scale);
          v6[yy * SX + xx] = v;
          if (v > m) m = v;
          // the glyph's colour: the most vivid sample, not the cell's muddy average
          const R = px[si * 4], G = px[si * 4 + 1], B = px[si * 4 + 2];
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          const score = v * (0.6 + (mx ? (mx - mn) / mx : 0));
          if (score > bestScore) { bestScore = score; best = si; }
        }
        const base = r * CH * ow + c * CW;
        if (!full) {
          for (let y = 0, o = base; y < CH; y++, o += ow) u32.fill(BG, o, o + CW);
        }
        if (m < 0.09) continue;
        // sharpen the shape inside the cell: light edges read as lines, not smudges
        const dens = Math.min(1, Math.pow(m, 0.8) * 1.05);
        for (let k = 0; k < v6.length; k++) {
          // faint cells match light (hairlines, not = or #); only strong
          // ones like lit screens get dense glyphs
          const q = Math.pow(v6[k] / m, 1.7) * dens * (0.42 + 0.48 * m * m);
          v6[k] = q;
          key = key * Q + Math.min(Q - 1, Math.floor(q * Q));
        }
        let gi = this.nearest(key, v6);
        if (gi === 0) gi = m > 0.5 ? gs.chars.indexOf(".") : 0;
        if (gi <= 0) continue;
        if (!full && noise[ci] > amount - 0.06) gi = gs.chars.indexOf("#");
        const R = px[best * 4], G = px[best * 4 + 1], B = px[best * 4 + 2];
        const mx = Math.max(R, G, B, 1);
        const k = (0.5 + 0.7 * dens) * 255 / mx;
        const lift = 26 + 40 * (1 - dens);
        const rr = Math.min(255, R * k + lift), gg = Math.min(255, G * k + lift), bb = Math.min(255, B * k + lift);
        const col = 0xff000000 | (bb << 16) | (gg << 8) | rr;
        const go = offs[gi];
        for (let j = 0; j < go.length; j++) u32[base + go[j]] = col;
      }
    }
    // glyph figures (furniture, then people) on top, each cell cleared first
    for (const f of figures) {
      for (let j = 0; j < f.rows.length; j++) {
        const row = [...f.rows[j]];
        const r = f.row + j;
        if (r < 0 || r >= rows) continue;
        for (let i = 0; i < row.length; i++) {
          const ch = row[i];
          const c = f.col + i;
          if (ch === " " || c < 0 || c >= cols) continue;
          if (!full && noise[r * cols + c] > amount) continue;
          const base = r * CH * ow + c * CW;
          for (let y = 0, o = base; y < CH; y++, o += ow) u32.fill(BG, o, o + CW);
          let go = this.figOffs.get(ch);
          if (!go) {
            go = Int32Array.from(maskOf(ch), (o) => Math.floor(o / CW) * ow + (o % CW));
            this.figOffs.set(ch, go);
          }
          const col = abgr(f.colors[j]?.[i] ?? "#ffffff");
          for (let k = 0; k < go.length; k++) u32[base + go[k]] = col;
        }
      }
    }
    out.g.putImageData(this.img!, 0, 0);
    dst.save();
    dst.setTransform(1, 0, 0, 1, 0, 0);
    dst.imageSmoothingEnabled = false;
    dst.drawImage(out.c, 0, 0, out.w * gp, out.h * gp);
    dst.restore();
  }
}
