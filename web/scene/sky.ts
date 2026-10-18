/*
 * What you see through the windows: a banded sky that follows the viewer's
 * local clock (night, dawn, day, dusk), sun and moon, twinkling stars, drifting
 * clouds, a three-layer parallax city whose windows light up after dark, and
 * on some days rain with the odd lightning flash (picked from the date, so
 * everyone's office has the same weather today).
 * Also exports the ambient darkness the lighting pass uses for the room.
 */
import { C, mix } from "./palette.ts";
import { bitmap, clamp, hash, rng, type Bitmap } from "./util.ts";

interface Key { h: number; top: string; mid: string; low: string; stars: number; lights: number; dark: number; haze: string }
const KEYS: Key[] = [
  { h: 0, top: "#060a1c", mid: "#0d1532", low: "#1a2350", stars: 1, lights: 1, dark: 0.68, haze: "#1a2350" },
  { h: 4.6, top: "#0a0f28", mid: "#18214a", low: "#2a2d60", stars: 0.9, lights: 0.95, dark: 0.64, haze: "#2a2d60" },
  { h: 6.1, top: "#2a2e64", mid: "#8a4c78", low: "#f08e5c", stars: 0.15, lights: 0.6, dark: 0.36, haze: "#c06a70" },
  { h: 7.4, top: "#3e6db6", mid: "#89b4e0", low: "#f2c88e", stars: 0, lights: 0.1, dark: 0.1, haze: "#b6c4d8" },
  { h: 10, top: "#3778cf", mid: "#6aaee9", low: "#b6e0f6", stars: 0, lights: 0, dark: 0, haze: "#a6c8e2" },
  { h: 16, top: "#3a76c6", mid: "#72ade1", low: "#d4e2d6", stars: 0, lights: 0, dark: 0.03, haze: "#b4c8d8" },
  { h: 18, top: "#3b4c93", mid: "#c0667a", low: "#f6a058", stars: 0.05, lights: 0.4, dark: 0.24, haze: "#c27a78" },
  { h: 19.4, top: "#1c1f50", mid: "#56386c", low: "#c25a5a", stars: 0.5, lights: 0.85, dark: 0.44, haze: "#6a3e66" },
  { h: 20.6, top: "#0a0f28", mid: "#131b40", low: "#24275a", stars: 1, lights: 1, dark: 0.66, haze: "#24275a" },
  { h: 24, top: "#060a1c", mid: "#0d1532", low: "#1a2350", stars: 1, lights: 1, dark: 0.68, haze: "#1a2350" },
];

export interface SkyState {
  hour: number;
  top: string;
  mid: string;
  low: string;
  haze: string;
  stars: number;
  lights: number;
  /** 0 = full daylight indoors, ~0.6 = night */
  dark: number;
  /** 0..1, how much sun comes through the windows */
  sun: number;
}

export function skyAt(hour: number): SkyState {
  const h = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].h <= h) i++;
  const a = KEYS[i], b = KEYS[i + 1];
  const t = clamp((h - a.h) / (b.h - a.h), 0, 1);
  const s = t * t * (3 - 2 * t);
  const sun = clamp(Math.min((h - 6.2) / 1.6, (18.6 - h) / 1.6), 0, 1);
  return {
    hour: h,
    top: mix(a.top, b.top, s), mid: mix(a.mid, b.mid, s), low: mix(a.low, b.low, s), haze: mix(a.haze, b.haze, s),
    stars: a.stars + (b.stars - a.stars) * s,
    lights: a.lights + (b.lights - a.lights) * s,
    dark: a.dark + (b.dark - a.dark) * s,
    sun,
  };
}

/** Rain on roughly one day in four, stable for the whole local day. */
export function rainyToday(d = new Date()): boolean {
  return hash(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`) % 4 === 0;
}

/** Bucketed so cached layers re-render only every few minutes of sky change. */
function bucket(h: number) {
  return Math.floor(h * 12);
}

interface Building { x: number; w: number; h: number; roof: number; seed: number }

export class Sky {
  private layers: { bm: Bitmap; par: number }[] = [];
  private key = "";
  private stars: { x: number; y: number; p: number; big: boolean }[] = [];
  private clouds: { x: number; y: number; w: number; s: number }[] = [];

  constructor(private seed = 7) {}

  private build(w: number, h: number, sky: SkyState) {
    const key = `${w}x${h}|${bucket(sky.hour)}`;
    if (key === this.key) return;
    this.key = key;
    const r = rng(this.seed);
    this.stars = [];
    for (let i = 0; i < (w * h) / 55; i++) this.stars.push({ x: r() * w, y: r() * h * 0.75, p: r() * 6.28, big: r() < 0.08 });
    this.clouds = [];
    for (let i = 0; i < Math.ceil(w / 70); i++) this.clouds.push({ x: r() * w, y: 3 + r() * h * 0.35, w: 10 + Math.floor(r() * 18), s: 0.6 + r() * 1.4 });
    const defs = [
      { par: 0.04, minH: 0.35, maxH: 0.75, minW: 7, maxW: 16, col: mix(sky.haze, sky.mid, 0.35), win: 0.25 },
      { par: 0.1, minH: 0.25, maxH: 0.6, minW: 9, maxW: 20, col: mix(sky.haze, C.blue1, 0.55), win: 0.55 },
      { par: 0.18, minH: 0.12, maxH: 0.38, minW: 12, maxW: 26, col: mix(sky.haze, C.ink2, 0.78), win: 0.9 },
    ];
    this.layers = defs.map((d, li) => {
      const lw = w + 160;
      const bm = bitmap(lw, h);
      const g = bm.g;
      const rr = rng(hash("city" + li) ^ this.seed);
      const bs: Building[] = [];
      let x = -4;
      while (x < lw) {
        const bw = d.minW + Math.floor(rr() * (d.maxW - d.minW));
        const bh = Math.floor(h * (d.minH + rr() * (d.maxH - d.minH)));
        bs.push({ x, w: bw, h: bh, roof: Math.floor(rr() * 4), seed: Math.floor(rr() * 1e9) });
        x += bw + (rr() < 0.3 ? 2 + Math.floor(rr() * 4) : 0);
      }
      const day = 1 - sky.lights;
      for (const b of bs) {
        const top = h - b.h;
        g.fillStyle = d.col;
        g.fillRect(b.x, top, b.w, b.h);
        // lit edge toward the sun / moon
        g.fillStyle = mix(d.col, sky.low, 0.25);
        g.fillRect(b.x, top, 1, b.h);
        // roofs: antenna, water tank, stepped crown
        if (b.roof === 1) { g.fillStyle = d.col; g.fillRect(b.x + Math.floor(b.w / 2), top - 5, 1, 5); }
        if (b.roof === 2 && b.w > 10) { g.fillStyle = d.col; g.fillRect(b.x + 2, top - 3, 5, 3); g.fillRect(b.x + 3, top - 4, 3, 1); }
        if (b.roof === 3 && b.w > 8) { g.fillStyle = d.col; g.fillRect(b.x + 2, top - 2, b.w - 4, 2); }
        // windows
        const wr = rng(b.seed);
        for (let wy = top + 3; wy < h - 2; wy += 3) {
          for (let wx = b.x + 2; wx < b.x + b.w - 2; wx += 3) {
            const v = wr();
            if (v < d.win * 0.5 * sky.lights) {
              g.fillStyle = v < 0.05 ? C.blue5 : v < 0.18 ? C.gold4 : C.gold3;
              g.globalAlpha = 0.55 + 0.45 * sky.lights;
              g.fillRect(wx, wy, 1 + (li === 2 ? 1 : 0), 1);
              g.globalAlpha = 1;
            } else if (day > 0.5 && v > 0.7) {
              g.fillStyle = mix(d.col, sky.top, 0.35);
              g.fillRect(wx, wy, 1 + (li === 2 ? 1 : 0), 1);
            }
          }
        }
      }
      return { bm, par: d.par };
    });
  }

  private rain(g: CanvasRenderingContext2D, room: { x: number; w: number }, top: number, height: number, time: number) {
    // streaks
    g.fillStyle = C.slate5;
    const n = Math.floor(room.w / 3);
    for (let i = 0; i < n; i++) {
      const sx = (i * 37.3) % room.w;
      const sp = 0.09 + ((i * 13) % 7) * 0.008;
      const y = ((time * sp + i * 53) % (height + 8)) - 4;
      g.globalAlpha = 0.25 + ((i * 7) % 5) * 0.06;
      const x = Math.floor(room.x + ((sx - y * 0.25) % room.w + room.w) % room.w);
      g.fillRect(x, Math.floor(top + y), 1, 3);
    }
    // drops sliding down the glass
    g.fillStyle = C.white;
    for (let i = 0; i < room.w / 9; i++) {
      const x = Math.floor(room.x + (i * 91.7) % room.w);
      const y = Math.floor(top + ((time * 0.006 * (1 + (i % 3)) + i * 29) % height));
      g.globalAlpha = 0.35;
      g.fillRect(x, y, 1, 2);
    }
    g.globalAlpha = 1;
    // lightning, now and then
    if (time > this.nextBolt) {
      this.nextBolt = time + 9000 + Math.random() * 16000;
      this.flash = 1;
    }
    if (this.flash > 0) {
      const f = this.flash;
      g.fillStyle = C.white;
      g.globalAlpha = f * (Math.floor(time / 60) % 2 ? 0.55 : 0.3);
      g.fillRect(room.x, top, room.w, height);
      g.globalAlpha = 1;
      this.flash = Math.max(0, f - 0.045);
    }
  }

  /**
   * Paint the outside into the window rects. `ox` is the world x of the room's
   * left edge; `pan` the camera offset that drives parallax.
   */
  /** 0..1 brightness of the current lightning flash, for the room lighting. */
  flash = 0;
  private nextBolt = 0;

  draw(g: CanvasRenderingContext2D, wins: { x: number; y: number; w: number; h: number }[], room: { x: number; w: number }, top: number, height: number, sky0: SkyState, time: number, pan: number, rain = false) {
    // rain greys the sky and hides sun and stars
    const sky = rain ? { ...sky0, top: mix(sky0.top, C.slate2, 0.35), mid: mix(sky0.mid, C.slate3, 0.4), low: mix(sky0.low, C.slate3, 0.45), stars: 0, sun: sky0.sun * 0.2 } : sky0;
    this.build(room.w, height, sky);
    g.save();
    g.beginPath();
    for (const r of wins) g.rect(r.x, r.y, r.w, r.h);
    g.clip();
    // banded sky
    const bands = 9;
    for (let i = 0; i < bands; i++) {
      const t = i / (bands - 1);
      g.fillStyle = t < 0.55 ? mix(sky.top, sky.mid, t / 0.55) : mix(sky.mid, sky.low, (t - 0.55) / 0.45);
      const y0 = top + Math.floor((height * i) / bands);
      const y1 = top + Math.floor((height * (i + 1)) / bands);
      g.fillRect(room.x, y0, room.w, y1 - y0);
    }
    // stars
    if (sky.stars > 0.02) {
      for (const s of this.stars) {
        const tw = 0.5 + 0.5 * Math.sin(time * 0.0018 + s.p * 7);
        const a = sky.stars * (0.35 + 0.65 * tw);
        if (a < 0.15) continue;
        g.globalAlpha = a;
        g.fillStyle = s.big ? C.gold4 : C.white;
        const x = Math.floor(room.x + s.x), y = Math.floor(top + s.y);
        g.fillRect(x, y, 1, 1);
        if (s.big && tw > 0.8) { g.globalAlpha = a * 0.5; g.fillRect(x - 1, y, 3, 1); g.fillRect(x, y - 1, 1, 3); }
      }
      g.globalAlpha = 1;
    }
    // sun / moon arc across the whole wall
    const h = sky.hour;
    if (!rain) {
    const isDay = h >= 6 && h < 19;
    const span = isDay ? (h - 6) / 13 : ((h >= 19 ? h - 19 : h + 5) / 11);
    const bx = room.x + 20 + span * (room.w - 40) - pan * 0.02;
    const by = top + height * 0.72 - Math.sin(span * Math.PI) * height * 0.58;
    if (isDay) {
      g.fillStyle = mix(C.gold4, sky.low, 0.2);
      g.globalAlpha = 0.25;
      g.beginPath(); g.arc(bx, by, 7, 0, 6.3); g.fill();
      g.globalAlpha = 1;
      g.fillStyle = C.gold4;
      g.fillRect(Math.floor(bx) - 2, Math.floor(by) - 3, 5, 7);
      g.fillRect(Math.floor(bx) - 3, Math.floor(by) - 2, 7, 5);
    } else {
      g.fillStyle = C.gold4;
      const mx = Math.floor(bx), my = Math.floor(by);
      g.fillRect(mx - 2, my - 3, 5, 7);
      g.fillRect(mx - 3, my - 2, 7, 5);
      g.fillStyle = sky.top;
      g.fillRect(mx, my - 3, 4, 5);
      g.fillRect(mx + 1, my + 2, 2, 1);
    }
    }
    // clouds
    const cloudA = rain ? 0.9 : sky.stars > 0.6 ? 0.18 : 0.75;
    for (const c of this.clouds) {
      const x = Math.floor(room.x + ((c.x + time * 0.0016 * c.s - pan * 0.03) % (room.w + 60)) - 30);
      const y = Math.floor(top + c.y);
      g.globalAlpha = cloudA;
      g.fillStyle = sky.stars > 0.6 ? C.slate2 : mix(C.white, sky.low, 0.25);
      g.fillRect(x + 2, y, c.w - 4, 1);
      g.fillRect(x, y + 1, c.w, 2);
      g.fillRect(x + 4, y - 1, Math.floor(c.w / 3), 1);
      g.fillStyle = sky.stars > 0.6 ? C.slate1 : mix(C.slate5, sky.mid, 0.3);
      g.fillRect(x + 1, y + 3, c.w - 2, 1);
    }
    g.globalAlpha = 1;
    // city, far to near
    for (const l of this.layers) {
      const off = Math.floor(-80 - pan * l.par);
      g.drawImage(l.bm.c, room.x + off, top);
    }
    if (rain) this.rain(g, room, top, height, time);
    else this.flash = 0;
    g.restore();
  }
}
