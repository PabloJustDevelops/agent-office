/*
 * The room itself. build() paints what only changes with the floor plan into
 * one cached layer: the office (plaster back wall, windows, honey-oak basket
 * weave parquet) and, when remote workers exist, the cloud wing beside it (a
 * glass curtain wall onto the sky, a raised server-room floor with lit seams,
 * the glass partition between the two). Pods are not in that layer: each
 * pod's rug and sign is its own cached bitmap (podBitmap) so pods can glide
 * when the rows reflow. drawLive() paints the moving parts every frame: the
 * clock, rack LEDs, the TV scoreboard (with a scrolling ticker when an agent
 * shouts), the wing's uplink tower and the fibre runs out to every remote pod.
 * The `ascii` variants are the same plan stripped to outlines on a flat
 * ground, which is what the ASCII pass samples.
 */
import type { AgentKind } from "../../src/shared/events.ts";
import { HOST_BRAND } from "../../src/shared/events.ts";
import { BRAND_ART, C, art, mix, rgba, type ArtKey, type BrandArt } from "./palette.ts";
import { FONT, MICRO, drawText, fit, measure } from "./font.ts";
import { pixelLogo, type LogoKind } from "./logos.ts";
import { MARK_STEP, RUG_TOP, WALL_H, PROP_W, type Block, type Rect } from "./layout.ts";
import * as P from "./props.ts";
import { bitmap, hash, rng, type Bitmap } from "./util.ts";

export type { Rect };

export interface RoomPlan {
  room: Rect;
  main: Rect;
  wing: Rect | null;
  /** every hole the sky shows through: office windows and the wing's glass */
  windows: Rect[];
  elevator: { x: number; y: number; doorX: number };
  tv: Rect;
  clock: { x: number; y: number };
  /** The neon "npx theagentoffice" sign on the back wall, when the wall has room for it. */
  sign: Rect | null;
  rack: { x: number; y: number };
  coffee: { x: number; y: number };
  cooler: { x: number; y: number };
  plants: { x: number; y: number; seed: number }[];
  uplink: { x: number; y: number } | null;
  /** extra pad around the room in the buffer, for things flying in */
  pad: number;
}

const WIN_TOP = 12;
const WIN_BOTTOM = WALL_H - 22;
/** Ground colour of the ASCII variant: the converter treats it as blank. */
export const ASCII_GROUND = "#0b0a13";

export function plan(main: Rect, wing: Rect | null, room: Rect): RoomPlan {
  const x0 = main.x, x1 = main.x + main.w;
  const elevator = { x: x0 + 12, y: WALL_H, doorX: x0 + 12 + P.ELEV_W / 2 };
  const rackX = x1 - 34;
  // A bigger screen when the wall is long enough: shouts on it have to read in a recording.
  const tvW = main.w >= 460 ? 132 : 100;
  const mid = Math.round(main.x + main.w / 2);
  const tv = { x: mid - tvW / 2 - 6, y: 10, w: tvW, h: tvW > 100 ? 44 : 40 };
  const clock = { x: tv.x + tv.w + 16, y: 24 };
  // Every screenshot of the office carries the install command: a neon sign on whichever side of
  // the TV has the wall for it (windows take what's left), else a plate under the TV.
  const signW = 100;
  const leftA = elevator.x + P.ELEV_W + 16, leftB = tv.x - 10;
  const rightA = clock.x + 16, rightB = rackX - 38;
  const sign = rightB - rightA >= signW + 4
    ? { x: rightA, y: 18, w: signW, h: 24 }
    : leftB - leftA >= signW + 4
      ? { x: leftB - signW - 2, y: 18, w: signW, h: 24 }
      : null;
  const windows: Rect[] = [];
  const fill = (a: number, b: number) => {
    const span = b - a;
    if (span < 30) return;
    const n = Math.max(1, Math.round(span / 52));
    const gap = 8;
    const w = Math.floor((span - gap * (n - 1)) / n);
    for (let i = 0; i < n; i++) windows.push({ x: a + i * (w + gap), y: WIN_TOP, w, h: WIN_BOTTOM - WIN_TOP });
  };
  const signLeft = !!sign && sign.x < tv.x;
  fill(elevator.x + P.ELEV_W + 16, signLeft ? sign!.x - 10 : tv.x - 10);
  fill(sign && !signLeft ? sign.x + sign.w + 12 : clock.x + 14, rackX - 38);
  const plants: RoomPlan["plants"] = [];
  for (let i = 0; i < windows.length - 1; i++) {
    const a = windows[i], b = windows[i + 1];
    if (b.x - (a.x + a.w) >= 6 && i % 2 === 1) plants.push({ x: a.x + a.w + 4, y: WALL_H + 8, seed: hash("plant" + i) });
  }
  if (tv.x - (elevator.x + P.ELEV_W) > 40 && !signLeft) plants.push({ x: tv.x - 4, y: WALL_H + 8, seed: 11 });
  let uplink: RoomPlan["uplink"] = null;
  if (wing && wing.y === 0) {
    // the wing's glass wall: tall panes between steel mullions, the uplink tower in front
    const gx0 = wing.x + 6, gx1 = wing.x + wing.w - 6;
    const n = Math.max(1, Math.round((gx1 - gx0) / 44));
    const pw = Math.floor((gx1 - gx0 - (n - 1) * 3) / n);
    for (let i = 0; i < n; i++) windows.push({ x: gx0 + i * (pw + 3), y: 8, w: pw, h: WALL_H - 14 });
    uplink = { x: wing.x + 16, y: WALL_H + 6 };
  } else if (wing) {
    uplink = { x: wing.x + 14, y: wing.y + 22 };
  }
  return {
    room, main, wing, windows, elevator, tv, clock, sign,
    rack: { x: rackX, y: WALL_H + 10 },
    coffee: { x: rackX - 32, y: WALL_H + 9 },
    cooler: { x: elevator.x + P.ELEV_W + 4, y: WALL_H + 8 },
    plants, uplink,
    pad: 120,
  };
}

const r = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, c: string) => {
  g.fillStyle = c;
  g.fillRect(x, y, w, h);
};

/* ------------------------------------------------------------- the floors */

/** Honey-oak basket weave: 12px tiles of three planks, alternating direction. */
function parquet(g: CanvasRenderingContext2D, X0: number, Y0: number, W: number, H: number) {
  const rr = rng(1234);
  const T = 12, PL = 4;
  const seam = mix(C.oak2, C.oak1, 0.35);
  for (let ty = 0; ty * T < H; ty++) {
    for (let tx = 0; tx * T < W; tx++) {
      const x = X0 + tx * T, y = Y0 + ty * T;
      const horiz = (tx + ty) % 2 === 0;
      for (let p = 0; p < 3; p++) {
        const tone = mix(C.oak3, C.oak4, 0.15 + rr() * 0.55);
        if (horiz) {
          r(g, x, y + p * PL, T, PL, tone);
          r(g, x, y + p * PL, T, 1, mix(tone, C.oak5, 0.35));
          r(g, x, y + p * PL + PL - 1, T, 1, mix(tone, C.oak2, 0.5));
          if (rr() < 0.3) r(g, x + 2 + Math.floor(rr() * 6), y + p * PL + 1 + Math.floor(rr() * 2), 2 + Math.floor(rr() * 3), 1, mix(tone, C.oak2, 0.3));
        } else {
          r(g, x + p * PL, y, PL, T, tone);
          r(g, x + p * PL, y, 1, T, mix(tone, C.oak5, 0.35));
          r(g, x + p * PL + PL - 1, y, 1, T, mix(tone, C.oak2, 0.5));
          if (rr() < 0.3) r(g, x + p * PL + 1 + Math.floor(rr() * 2), y + 2 + Math.floor(rr() * 6), 1, 2 + Math.floor(rr() * 3), mix(tone, C.oak2, 0.3));
        }
      }
      r(g, x + T - 1, y, 1, T, seam);
      r(g, x, y + T - 1, T, 1, seam);
    }
  }
}

/** Raised server-room floor: bevelled tiles, perforated vents, glowing seams. */
function serverFloor(g: CanvasRenderingContext2D, X0: number, Y0: number, W: number, H: number) {
  const T = 16;
  const rr = rng(77);
  for (let ty = 0; ty * T < H; ty++) {
    for (let tx = 0; tx * T < W; tx++) {
      const x = X0 + tx * T, y = Y0 + ty * T;
      const vent = rr() < 0.18;
      r(g, x, y, T, T, vent ? C.sv1 : C.sv2);
      r(g, x, y, T, 1, mix(C.sv3, C.sv4, 0.4));
      r(g, x, y, 1, T, C.sv3);
      r(g, x + T - 1, y, 1, T, C.sv0);
      r(g, x, y + T - 1, T, 1, C.sv0);
      if (vent) for (let j = 3; j < T - 2; j += 3) for (let i = 3; i < T - 2; i += 3) r(g, x + i, y + j, 1, 1, C.sv0);
    }
  }
  // lit seams every few tiles: the floor is the network
  g.fillStyle = rgba(C.cyan3, 0.22);
  for (let y = Y0 + T * 3; y < Y0 + H; y += T * 4) g.fillRect(X0, y - 1, W, 1);
}

/* ---------------------------------------------------------- static layer */

/** Static layer in buffer coordinates (world - origin). */
export function build(p: RoomPlan, origin: { x: number; y: number }, size: { w: number; h: number }, ascii = false): Bitmap {
  const b = bitmap(size.w, size.h);
  const g = b.g;
  g.save();
  g.translate(-origin.x, -origin.y);
  if (ascii) buildAscii(g, p);
  else {
    buildOffice(g, p);
    if (p.wing) buildWing(g, p);
  }
  g.restore();
  return b;
}

function buildOffice(g: CanvasRenderingContext2D, p: RoomPlan) {
  const m = p.main;
  const X0 = m.x, X1 = m.x + m.w, Y1 = m.y + m.h;
  const rr = rng(4321);
  g.save();
  g.beginPath();
  g.rect(X0, WALL_H, m.w, Y1 - WALL_H);
  g.clip();
  parquet(g, X0, WALL_H, m.w, Y1 - WALL_H);
  // soft depth: the floor darkens toward the walls, brightest mid-room
  for (let i = 0; i < 8; i++) {
    g.fillStyle = rgba(C.oak1, 0.05);
    g.fillRect(X0, WALL_H, m.w, 12 - i);
    g.fillRect(X0, WALL_H, 12 - i * 1.4, Y1 - WALL_H);
    g.fillRect(X1 - 12 + i * 1.4, WALL_H, 12 - i * 1.4, Y1 - WALL_H);
    g.fillRect(X0, Y1 - 8 + i, m.w, 8 - i);
  }
  // the corridor along the back wall: a darker walnut runner with a brass edge
  r(g, X0, WALL_H + 11, m.w, 15, rgba(C.oak1, 0.42));
  r(g, X0, WALL_H + 11, m.w, 1, rgba(C.gold2, 0.35));
  r(g, X0, WALL_H + 25, m.w, 1, rgba(C.gold2, 0.25));
  g.restore();

  // ---- back wall
  r(g, X0, 0, m.w, WALL_H, C.wall4);
  for (let i = 0; i < m.w / 3; i++) r(g, X0 + Math.floor(rr() * m.w), 6 + Math.floor(rr() * (WALL_H - 26)), 1, 1, mix(C.wall4, C.wall3, 0.35));
  r(g, X0, 0, m.w, 4, C.wall1);
  r(g, X0, 4, m.w, 1, C.wall5);
  r(g, X0, 5, m.w, 1, C.wall3);
  const wy = WALL_H - 16;
  r(g, X0, wy, m.w, 13, C.wood3);
  r(g, X0, wy, m.w, 2, C.wood5);
  r(g, X0, wy + 2, m.w, 1, C.wood2);
  for (let x = X0 + 4; x < X1 - 6; x += 14) {
    r(g, x, wy + 4, 10, 7, mix(C.wood3, C.wood4, 0.5));
    r(g, x, wy + 4, 10, 1, C.wood2);
    r(g, x, wy + 4, 1, 7, C.wood2);
    r(g, x + 1, wy + 10, 9, 1, C.wood5);
  }
  r(g, X0, WALL_H - 3, m.w, 3, C.wood1);
  r(g, X0, WALL_H - 3, m.w, 1, C.wood2);

  // ---- windows: punch holes, then frames
  for (const w of p.windows) {
    if (w.x > X1) continue;
    g.clearRect(w.x, w.y, w.w, w.h);
    glassSheen(g, w);
    const f = C.slate5, fd = C.slate3;
    r(g, w.x - 2, w.y - 2, w.w + 4, 2, f);
    r(g, w.x - 2, w.y, 2, w.h, f);
    r(g, w.x + w.w, w.y, 2, w.h, fd);
    r(g, w.x - 3, w.y + w.h, w.w + 6, 2, C.white);
    r(g, w.x - 3, w.y + w.h + 2, w.w + 6, 1, C.wall2);
    const mx = w.x + Math.floor(w.w / 2);
    r(g, mx - 1, w.y, 2, w.h, f);
    r(g, mx, w.y, 1, w.h, fd);
    r(g, w.x, w.y + Math.floor(w.h * 0.38), w.w, 1, f);
    g.fillStyle = rgba(C.ink, 0.12);
    g.fillRect(w.x - 3, w.y + w.h + 3, w.w + 6, 2);
  }

  // ---- TV frame (screen drawn live)
  const tv = p.tv;
  r(g, tv.x - 3, tv.y - 3, tv.w + 6, tv.h + 6, C.ink);
  r(g, tv.x - 2, tv.y - 2, tv.w + 4, 1, C.slate1);
  r(g, tv.x + tv.w / 2 - 6, tv.y + tv.h + 3, 12, 2, C.ink2);
  g.fillStyle = rgba(C.ink, 0.18);
  g.fillRect(tv.x - 1, tv.y + tv.h + 3, tv.w + 5, 3);

  P.clockFace(g, p.clock.x, p.clock.y);
  g.fillStyle = rgba(C.ink, 0.15);
  g.fillRect(p.clock.x - 6, p.clock.y + 9, 14, 2);

  // ---- the neon sign's backing board and mounting rails (the tubes are lit live)
  if (p.sign) {
    const s = p.sign;
    r(g, s.x - 2, s.y - 2, s.w + 4, s.h + 4, C.ink);
    r(g, s.x - 1, s.y - 1, s.w + 2, s.h + 2, mix(C.ink, C.plum1, 0.35));
    r(g, s.x - 1, s.y - 1, s.w + 2, 1, rgba(C.white, 0.08));
    r(g, s.x + 6, s.y - 5, 1, 3, C.slate2);
    r(g, s.x + s.w - 7, s.y - 5, 1, 3, C.slate2);
    g.fillStyle = rgba(C.ink, 0.16);
    g.fillRect(s.x, s.y + s.h + 2, s.w + 3, 2);
  }

  P.elevatorFrame(g, p.elevator.x, p.elevator.y);
  drawText(g, MICRO(), "LIFT", p.elevator.x + 2, p.elevator.y - P.ELEV_H - 17, C.wall2);

  P.waterCooler(g, p.cooler.x, p.cooler.y);
  P.coffeeMachine(g, p.coffee.x, p.coffee.y);
  P.rack(g, p.rack.x, p.rack.y);
  for (const pl of p.plants) P.plantTall(g, pl.x, pl.y, pl.seed);
  g.fillStyle = rgba(C.ink, 0.22);
  g.fillRect(p.cooler.x - 1, p.cooler.y, 12, 2);
  g.fillRect(p.coffee.x - 1, p.coffee.y, 28, 2);
  g.fillRect(p.rack.x - 1, p.rack.y, 22, 2);
}

function glassSheen(g: CanvasRenderingContext2D, w: Rect) {
  g.fillStyle = rgba(C.white, 0.08);
  for (let i = 0; i < w.h; i++) {
    const sx = w.x + 4 + Math.floor(i * 0.6);
    if (sx + 3 < w.x + w.w) g.fillRect(sx, w.y + w.h - 1 - i, 3, 1);
  }
  g.fillStyle = rgba(C.white, 0.05);
  for (let i = 0; i < w.h; i++) {
    const sx = w.x + 12 + Math.floor(i * 0.6);
    if (sx + 1 < w.x + w.w) g.fillRect(sx, w.y + w.h - 1 - i, 1, 1);
  }
}

function buildWing(g: CanvasRenderingContext2D, p: RoomPlan) {
  const wg = p.wing!;
  const below = wg.y > 0;
  const X0 = wg.x, Y1 = wg.y + wg.h;
  const floorTop = below ? wg.y + 14 : WALL_H;
  g.save();
  g.beginPath();
  g.rect(X0, floorTop, wg.w, Y1 - floorTop);
  g.clip();
  serverFloor(g, X0, floorTop, wg.w, Y1 - floorTop);
  for (let i = 0; i < 6; i++) {
    g.fillStyle = rgba(C.sv0, 0.08);
    g.fillRect(X0, floorTop, wg.w, 10 - i);
    g.fillRect(X0, Y1 - 6 + i, wg.w, 6 - i);
  }
  g.restore();

  if (!below) {
    // steel curtain wall, glass panes punched through
    r(g, X0, 0, wg.w, WALL_H, C.steel1);
    r(g, X0, 0, wg.w, 3, C.sv0);
    r(g, X0, 3, wg.w, 1, C.steel3);
    for (const w of p.windows) {
      if (w.x < X0) continue;
      g.clearRect(w.x, w.y, w.w, w.h);
      g.fillStyle = rgba(C.cyan4, 0.06);
      g.fillRect(w.x, w.y, w.w, w.h);
      glassSheen(g, w);
      r(g, w.x - 1, w.y - 1, w.w + 2, 1, C.steel3);
      r(g, w.x + w.w, w.y, 1, w.h, C.steel2);
    }
    // base: a lit kick plate where glass meets floor
    r(g, X0, WALL_H - 6, wg.w, 6, C.sv1);
    r(g, X0, WALL_H - 6, wg.w, 1, C.steel3);
    r(g, X0, WALL_H - 2, wg.w, 2, C.sv0);
    g.fillStyle = rgba(C.cyan3, 0.5);
    g.fillRect(X0 + 4, WALL_H - 4, wg.w - 8, 1);
    // the glass partition between the office and the wing
    const px = X0 - 12;
    r(g, px, 0, 12, Y1, C.steel2);
    r(g, px + 1, 0, 1, Y1, C.steel4);
    r(g, px + 10, 0, 1, Y1, C.steel1);
    r(g, px + 3, WALL_H, 6, Y1 - WALL_H, mix(C.blue2, C.steel2, 0.35));
    g.fillStyle = rgba(C.cyan4, 0.18);
    for (let y = WALL_H + 6; y < Y1; y += 22) g.fillRect(px + 4, y, 1, 9);
    g.fillStyle = rgba(C.white, 0.12);
    g.fillRect(px + 6, WALL_H, 1, Y1 - WALL_H);
    // posts
    for (let y = WALL_H; y < Y1; y += 64) { r(g, px + 2, y, 8, 3, C.steel3); r(g, px + 2, y + 2, 8, 1, C.steel1); }
  } else {
    // portrait: the wing is a lower deck behind a glass rail
    r(g, X0, wg.y, wg.w, 14, C.steel1);
    r(g, X0, wg.y, wg.w, 2, C.steel3);
    g.fillStyle = rgba(C.cyan3, 0.5);
    g.fillRect(X0, wg.y + 12, wg.w, 1);
  }
  // wing sign: a neon "CLOUD" over the uplink
  const f = FONT();
  const sx = below ? X0 + 34 : X0 + 36, sy = below ? wg.y + 3 : 2;
  const label = "CLOUD";
  const tw = measure(f, label);
  r(g, sx - 3, sy, tw + 18, 11, C.sv0);
  r(g, sx - 3, sy + 10, tw + 18, 1, C.cyan3);
  cloudGlyph(g, sx, sy + 3, C.cyan4);
  drawText(g, f, label, sx + 12, sy + 2, C.cyan4);
}

/** A tiny pixel cloud, 9 x 5. */
function cloudGlyph(g: CanvasRenderingContext2D, x: number, y: number, col: string) {
  r(g, x + 3, y, 3, 1, col); r(g, x + 1, y + 1, 6, 1, col); r(g, x + 2, y + 1, 1, 1, col);
  r(g, x, y + 2, 9, 2, col); r(g, x + 1, y + 4, 7, 1, col);
}

/** The outline-only plan the ASCII pass samples: flat ground, edges and furniture. */
function buildAscii(g: CanvasRenderingContext2D, p: RoomPlan) {
  const room = p.room;
  r(g, room.x - p.pad, room.y - p.pad, room.w + p.pad * 2, room.h + p.pad * 2, ASCII_GROUND);
  const line = (x: number, y: number, w: number, h: number, c: string = C.slate3) => r(g, x, y, w, h, c);
  for (const part of [p.main, p.wing]) {
    if (!part) continue;
    const below = part.y > 0;
    const top = below ? part.y : 0;
    // walls: the outline of the room and the skirting line
    line(part.x, top, part.w, 1, C.slate4);
    line(part.x, below ? top + 13 : WALL_H - 1, part.w, 1, C.slate4);
    line(part.x, top, 1, part.h, C.slate2);
    line(part.x + part.w - 1, top, 1, part.h, C.slate2);
    line(part.x, part.y + part.h - 1, part.w, 1, C.slate2);
  }
  for (const w of p.windows) {
    g.clearRect(w.x, w.y, w.w, w.h);
    line(w.x - 1, w.y - 1, w.w + 2, 1, C.slate4);
    line(w.x - 1, w.y + w.h, w.w + 2, 1, C.slate4);
    line(w.x - 1, w.y, 1, w.h, C.slate4);
    line(w.x + w.w, w.y, 1, w.h, C.slate4);
  }
  const tv = p.tv;
  line(tv.x - 2, tv.y - 2, tv.w + 4, 1, C.slate4); line(tv.x - 2, tv.y + tv.h + 1, tv.w + 4, 1, C.slate4);
  line(tv.x - 2, tv.y - 2, 1, tv.h + 4, C.slate4); line(tv.x + tv.w + 1, tv.y - 2, 1, tv.h + 4, C.slate4);
  P.clockFace(g, p.clock.x, p.clock.y);
  if (p.sign) {
    const sg = p.sign;
    line(sg.x - 2, sg.y - 2, sg.w + 4, 1, C.slate4); line(sg.x - 2, sg.y + sg.h + 1, sg.w + 4, 1, C.slate4);
    line(sg.x - 2, sg.y - 2, 1, sg.h + 4, C.slate4); line(sg.x + sg.w + 1, sg.y - 2, 1, sg.h + 4, C.slate4);
  }
  // big furniture as outlines: solid blocks would turn into walls of glyphs
  const box = (x: number, y: number, w: number, h: number, c: string = C.slate4) => {
    line(x, y, w, 1, c); line(x, y + h - 1, w, 1, c); line(x, y, 1, h, c); line(x + w - 1, y, 1, h, c);
  };
  const el = p.elevator;
  box(el.x, el.y - P.ELEV_H - 10, P.ELEV_W, P.ELEV_H + 10, C.slate5);
  box(el.x + 2, el.y - P.ELEV_H, P.ELEV_W - 4, P.ELEV_H, C.slate3);
  line(el.x + 11, el.y - P.ELEV_H - 8, 14, 6, C.red2);
  box(p.rack.x, p.rack.y - 52, 20, 52, C.slate4);
  for (let i = 1; i < 5; i++) line(p.rack.x + 3, p.rack.y - 52 + i * 10, 14, 1, C.green3);
  box(p.coffee.x, p.coffee.y - 12, 26, 12, C.wood4);
  box(p.coffee.x + 3, p.coffee.y - 26, 12, 14, C.slate4);
  box(p.cooler.x, p.cooler.y - 16, 10, 16, C.slate5);
  box(p.cooler.x + 1, p.cooler.y - 27, 8, 11, C.blue4);
  for (const pl of p.plants) P.plantTall(g, pl.x, pl.y, pl.seed);
  if (p.wing && p.wing.y === 0) line(p.wing.x - 6, WALL_H, 1, p.room.h - WALL_H, C.cyan3);
}

/* ----------------------------------------------------------------- pods */

const podCache = new WeakMap<Block, { key: string; bm: Bitmap }>();
/** Overhang around a pod's box in its bitmap (tassels, shadow, sign). */
export const POD_BM_PAD = 4;

/** The art key a pod's furniture uses: its agent, or its remote host's server style. */
export function podArt(b: Block): ArtKey {
  return b.zone === "cloud" && b.host && b.host.kind !== "local" ? (`host-${b.host.kind}` as ArtKey) : b.agent;
}

/** A pod's rug (or server platform) and hanging sign, cached until it changes. */
export function podBitmap(b: Block, ascii: boolean): Bitmap {
  const key = `${b.rev}|${b.w}x${b.h}|${ascii}|${b.offline}|${b.label}|${b.mix.join()}`;
  const have = podCache.get(b);
  if (have && have.key === key) return have.bm;
  const bm = bitmap(b.w + POD_BM_PAD * 2, b.h + POD_BM_PAD * 2);
  const g = bm.g;
  g.translate(POD_BM_PAD, POD_BM_PAD);
  if (b.zone === "cloud") platform(g, b, ascii);
  else rug(g, b, ascii);
  if (!ascii) sign(g, b);
  podCache.set(b, { key, bm });
  return bm;
}

function rug(g: CanvasRenderingContext2D, b: Block, ascii: boolean) {
  const A = BRAND_ART[b.agent] ?? BRAND_ART.claude;
  const [fill, border, pat] = A.rug;
  const x = 0, y = RUG_TOP, w = b.w, h = b.h - RUG_TOP - 1;
  if (ascii) {
    // the rug as a thin outline in its brand colour
    const c = mix(A.ink, C.ink, 0.45);
    r(g, x, y, w, 1, c); r(g, x, y + h - 1, w, 1, c);
    r(g, x, y, 1, h, c); r(g, x + w - 1, y, 1, h, c);
    return;
  }
  g.fillStyle = rgba(C.ink, 0.28);
  g.fillRect(x + 1, y + 2, w, h);
  r(g, x, y, w, h, fill);
  const frame = (inset: number, c: string) => {
    r(g, x + inset, y + inset, w - inset * 2, 1, c); r(g, x + inset, y + h - 1 - inset, w - inset * 2, 1, c);
    r(g, x + inset, y + inset, 1, h - inset * 2, c); r(g, x + w - 1 - inset, y + inset, 1, h - inset * 2, c);
  };
  const inner = { x0: x + 6, y0: y + 6, x1: x + w - 6, y1: y + h - 6 };
  const each = (sx: number, sy: number, fn: (xx: number, yy: number, i: number, j: number) => void) => {
    for (let yy = inner.y0, j = 0; yy < inner.y1; yy += sy, j++) for (let xx = inner.x0, i = 0; xx < inner.x1; xx += sx, i++) fn(xx, yy, i, j);
  };
  switch (A.pattern) {
    case "checker": {
      // crisp monochrome: black/white checker border, fine dot grid
      const lite = "#c4c4ca";
      for (let i = 0; i < w; i += 2) { r(g, x + i, y, 2, 2, (i / 2) % 2 ? lite : C.cc0); r(g, x + i, y + h - 2, 2, 2, (i / 2) % 2 ? C.cc0 : lite); }
      for (let j = 0; j < h; j += 2) { r(g, x, y + j, 2, 2, (j / 2) % 2 ? lite : C.cc0); r(g, x + w - 2, y + j, 2, 2, (j / 2) % 2 ? C.cc0 : lite); }
      frame(4, C.cc0);
      each(5, 5, (xx, yy) => r(g, xx + 2, yy + 2, 1, 1, pat));
      break;
    }
    case "diamond": {
      frame(2, border); frame(4, pat);
      each(8, 8, (xx, yy, i, j) => { const ox = j % 2 ? 4 : 0; if (xx + ox + 2 < inner.x1) { r(g, xx + ox + 1, yy, 1, 1, pat); r(g, xx + ox, yy + 1, 3, 1, pat); r(g, xx + ox + 1, yy + 2, 1, 1, pat); } void i; });
      for (let i = 4; i < w - 4; i += 3) { r(g, x + i, y - 1, 1, 1, border); r(g, x + i, y + h, 1, 1, border); }
      break;
    }
    case "hex": {
      frame(2, border);
      each(10, 7, (xx, yy, i, j) => { const ox = j % 2 ? 5 : 0; if (xx + ox + 4 < inner.x1) { r(g, xx + ox + 1, yy, 3, 1, pat); r(g, xx + ox, yy + 1, 1, 2, pat); r(g, xx + ox + 4, yy + 1, 1, 2, pat); r(g, xx + ox + 1, yy + 3, 3, 1, pat); } void i; });
      break;
    }
    case "blocks": {
      // opencode: a terminal-block weave, peach squares on charcoal
      frame(1, border); frame(3, mix(fill, border, 0.25));
      each(7, 7, (xx, yy, i, j) => { if ((i + j) % 3 === 0) { r(g, xx, yy, 4, 4, pat); r(g, xx + 1, yy + 1, 2, 2, fill); } });
      break;
    }
    case "chevron": {
      // droid: hazard chevrons at the ends, a steel deck between
      frame(1, border);
      for (let i = 0; i < w - 2; i++) for (let j = 0; j < 4; j++) if (((i + j) >> 2) % 2 === 0) { r(g, x + 1 + i, y + 1 + j, 1, 1, border); r(g, x + 1 + i, y + h - 5 + j, 1, 1, border); }
      each(6, 6, (xx, yy) => r(g, xx + 2, yy + 2, 1, 1, pat));
      break;
    }
    case "sparkle": {
      // gemini: four-point sparkles in blue, violet and pink on deep indigo
      frame(2, border);
      const cols = [C.gmBlue, C.gm4, C.gmPink];
      each(12, 10, (xx, yy, i, j) => {
        const ox = j % 2 ? 6 : 0, c = cols[(i + j) % 3];
        if (xx + ox + 3 > inner.x1) return;
        r(g, xx + ox + 1, yy, 1, 3, c); r(g, xx + ox, yy + 1, 3, 1, c);
      });
      break;
    }
    case "tri": {
      // qwen: interlocking triangles
      frame(2, border);
      each(8, 6, (xx, yy, i, j) => { const ox = j % 2 ? 4 : 0; if (xx + ox + 4 < inner.x1) { r(g, xx + ox + 2, yy, 1, 1, pat); r(g, xx + ox + 1, yy + 1, 3, 1, pat); r(g, xx + ox, yy + 2, 5, 1, pat); } void i; });
      break;
    }
    case "cube": {
      // cursor: isometric cubes in graphite
      frame(1, border); frame(3, pat);
      each(8, 8, (xx, yy, i, j) => { const ox = j % 2 ? 4 : 0; if (xx + ox + 4 < inner.x1) { r(g, xx + ox + 1, yy, 2, 1, border); r(g, xx + ox, yy + 1, 4, 2, pat); r(g, xx + ox + 2, yy + 1, 2, 2, mix(pat, C.ink, 0.35)); } void i; });
      break;
    }
    default:
      frame(2, border);
  }
  // brand emblem woven into the rug, bottom-right
  const em = pixelLogo(b.agent as LogoKind, 11, b.agent === "commandcode" ? C.cc6 : mix(pat, A.light, 0.3));
  g.globalAlpha = 0.85;
  g.drawImage(em.c, w - 18, b.h - 15);
  g.globalAlpha = 1;
}

/** A remote pod: a raised platform floating over the server floor, rimmed in the host colour. */
function platform(g: CanvasRenderingContext2D, b: Block, ascii: boolean) {
  const kind = b.host?.kind && b.host.kind !== "local" ? b.host.kind : "ssh";
  const col = HOST_BRAND[kind].color;
  const x = 0, y = RUG_TOP - 2, w = b.w, h = b.h - RUG_TOP;
  if (ascii) {
    r(g, x, y, w, 1, col); r(g, x, y + h - 1, w, 1, col);
    r(g, x, y, 1, h, col); r(g, x + w - 1, y, 1, h, col);
    r(g, x + 2, y + h - 3, w - 4, 1, mix(col, C.ink, 0.5));
    return;
  }
  const dim = b.offline;
  // hover shadow and the slab's edge
  g.fillStyle = rgba(C.sv0, 0.6);
  g.fillRect(x + 3, y + h + 1, w - 2, 3);
  r(g, x, y + h - 3, w, 4, C.sv0);
  r(g, x, y, w, h - 2, C.sv1);
  // deck grid
  for (let yy = y + 4; yy < y + h - 4; yy += 6) r(g, x + 3, yy, w - 6, 1, C.sv2);
  for (let xx = x + 4; xx < x + w - 3; xx += 8) r(g, xx, y + 3, 1, h - 7, C.sv2);
  // rim light in the host colour, brighter on the front edge
  const rim = dim ? mix(col, C.sv1, 0.7) : col;
  r(g, x, y, w, 1, mix(rim, C.sv1, 0.4));
  r(g, x, y, 1, h - 2, mix(rim, C.sv1, 0.5));
  r(g, x + w - 1, y, 1, h - 2, mix(rim, C.sv1, 0.5));
  r(g, x, y + h - 3, w, 1, rim);
  // corner brackets
  for (const [cx, cy, sx, sy] of [[x + 2, y + 2, 1, 1], [x + w - 3, y + 2, -1, 1], [x + 2, y + h - 5, 1, -1], [x + w - 3, y + h - 5, -1, -1]] as const) {
    r(g, cx, cy, 3 * sx || 1, 1, rim);
    r(g, sx > 0 ? cx : cx, sy > 0 ? cy : cy - 2, 1, 3, rim);
  }
  // the host mark etched into the deck
  const em = pixelLogo(kind as LogoKind, 11, mix(rim, C.sv1, 0.45));
  g.drawImage(em.c, w - 17, b.h - 17);
}

/** The platform's name as a cloud pod's sign spells it, in small caps before the sandbox name. */
export const PLATFORM_TAG: Record<string, string> = { ssh: "SSH", daytona: "DAYTONA", boat: "BOAT", railway: "RAILWAY", vercel: "VERCEL" };

function sign(g: CanvasRenderingContext2D, b: Block) {
  const f = FONT(), m = MICRO();
  const remote = b.zone === "cloud";
  const kind = remote && b.host?.kind && b.host.kind !== "local" ? b.host.kind : null;
  const A: BrandArt = remote && kind ? art(`host-${kind}` as ArtKey) : BRAND_ART[b.agent] ?? BRAND_ART.claude;
  // A cloud pod says which cloud: "RAILWAY edge-cache", the platform in its own colour.
  const tag = kind ? PLATFORM_TAG[kind] ?? "" : "";
  // A pod two agents share carries both marks, stepped like a stack of badges.
  const marks = remote ? [] : b.mix.slice(0, 3);
  const extra = Math.max(0, marks.length - 1) * MARK_STEP;
  const tagW = (tag ? measure(m, tag) + 5 : 0) + extra;
  const maxText = Math.max(24, b.w - 23 - tagW - (b.offline ? 44 : 0));
  const label = fit(f, b.label, maxText);
  const tw = measure(f, label) + tagW;
  const w = tw + 21 + (b.offline ? 44 : 0);
  const x = 2, y = 2;
  const plate = remote ? C.sv0 : A.plate;
  const edge = remote ? (kind ? HOST_BRAND[kind].color : C.slate4) : A.ink;
  if (!remote) { r(g, x + 4, y - 5, 1, 5, C.slate2); r(g, x + w - 5, y - 5, 1, 5, C.slate2); }
  g.fillStyle = rgba(C.ink, 0.25);
  g.fillRect(x + 2, y + 13, w, 3);
  r(g, x + 1, y, w - 2, 13, plate); r(g, x, y + 1, w, 11, plate);
  r(g, x + 1, y + 12, w - 2, 1, b.offline ? C.slate2 : edge);
  r(g, x + 1, y, w - 2, 1, mix(plate, C.slate3, 0.4));
  if (marks.length > 1) {
    // back to front, so the pod's own mark is on top
    for (let i = marks.length - 1; i >= 0; i--) {
      const a = marks[i]!;
      const lg = pixelLogo(a as LogoKind, 9, b.offline ? C.slate3 : (BRAND_ART[a] ?? BRAND_ART.claude).ink);
      r(g, x + 2 + i * MARK_STEP, y + 1, 11, 11, plate);
      g.drawImage(lg.c, x + 3 + i * MARK_STEP, y + 2);
    }
  } else {
    const logoKind = (kind ?? b.agent) as LogoKind;
    const lg = pixelLogo(logoKind, 9, b.offline ? C.slate3 : remote ? HOST_BRAND[kind!]?.color ?? C.slate4 : A.ink);
    g.drawImage(lg.c, x + 3, y + 2);
  }
  if (tag) drawText(g, m, tag, x + 15, y + 4, b.offline ? C.slate3 : HOST_BRAND[kind!]?.color ?? C.slate4);
  drawText(g, f, label, x + 15 + tagW, y + 3, b.offline ? C.slate3 : C.white);
  if (b.offline) {
    P.unplugged(g, x + 18 + tw, y + 3, 0);
    drawText(g, MICRO(), "OFFLINE", x + 34 + tw, y + 4, C.red3);
  }
}

/** Where a pod's sign sits, relative to the pod's top-left (for the vector overlay). */
export const SIGN_LOGO = { x: 5, y: 4, size: 9 };

/** Props on the spare end of a pod's rug, drawn in the y-sorted pass. */
export function podProps(b: Block): { kind: string; x: number; y: number }[] {
  const out: { kind: string; x: number; y: number }[] = [];
  let x = b.x + b.w - 6;
  for (const p of b.props) {
    const pw = PROP_W[p];
    x -= pw;
    out.push({ kind: p, x: Math.round(x), y: Math.round(b.y) + b.propY + 52 });
    x -= 3;
  }
  return out;
}

/* ---------------------------------------------------------- live pieces */

export interface Shout { text: string; agent: AgentKind; t0: number }

/** TV, clock, rack LEDs. Elevator doors are drawn by the scene (they need y-order). */
export interface Board {
  workers: number;
  tools: number;
  flips: number;
  byAgent: Record<AgentKind, number>;
  spark: number[];
  /** Sessions waiting on their human right now. */
  waiting?: number;
  live: boolean;
  /** latest agent shouts, newest last; the TV runs the newest as a ticker */
  shouts: Shout[];
}

export const SHOUT_MS = 16_000;
/** A shout fills the whole TV this long before it shrinks to a band. */
export const SHOUT_HOLD_MS = 3_200;

/** Up to `max` lines of `text` within `maxW` font px, the last one trimmed with an ellipsis. */
function wrap(f: ReturnType<typeof FONT>, text: string, maxW: number, max: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (measure(f, next) <= maxW || !cur) cur = next;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  if (out.length > max) out.splice(max - 1, out.length, out.slice(max - 1).join(" "));
  return out.map((l) => fit(f, l, maxW));
}

/** An agent's mark for the TV: the hand-pixelled one at TV sizes. */
function logoMark(agent: AgentKind, px: number): Bitmap {
  return pixelLogo(agent as LogoKind, px, (BRAND_ART[agent] ?? BRAND_ART.claude).ink);
}

export function drawLive(g: CanvasRenderingContext2D, p: RoomPlan, t: number, now: Date, board: Board, activity: number, ascii = false) {
  P.clockHands(g, p.clock.x, p.clock.y, now);
  if (p.sign) neonSign(g, p.sign, t, ascii);
  else {
    // no wall for the neon: the command on a small plate under the TV
    const m = MICRO(), cmd = "NPX THEAGENTOFFICE";
    const w = measure(m, cmd) + 6, x = p.tv.x + Math.floor((p.tv.w - w) / 2), y = p.tv.y + p.tv.h + 7;
    r(g, x, y, w, 9, C.ink);
    drawText(g, m, cmd, x + 3, y + 2, ascii ? C.slate5 : "#7ef6ff");
  }
  if (ascii) return; // the label pass writes the TV as real text
  P.rackLeds(g, p.rack.x, p.rack.y, t, activity);
  tvScreen(g, p.tv, t, board);
}

/** Neon tubes: "AGENT OFFICE" over "npx theagentoffice", with the odd flicker of a real sign. */
function neonSign(g: CanvasRenderingContext2D, s: Rect, t: number, ascii: boolean) {
  const f = FONT(), m = MICRO();
  const cmd = "npx theagentoffice";
  const head = "AGENT OFFICE";
  // a two-frame stutter every ~9s on the top line, like a tube on its way out
  const ph = t % 9_000;
  const stutter = ph > 8_600 && Math.floor(ph / 70) % 2 === 0;
  const pink = ascii ? C.slate5 : "#ff6fb5", cyan = ascii ? C.slate5 : "#7ef6ff";
  const hx = s.x + Math.floor((s.w - measure(m, head)) / 2), cx = s.x + Math.floor((s.w - measure(f, cmd)) / 2);
  if (!ascii) {
    // the glow halo behind each line
    g.fillStyle = rgba(pink, stutter ? 0.04 : 0.14);
    g.fillRect(hx - 2, s.y + 2, measure(m, head) + 4, 9);
    g.fillStyle = rgba(cyan, 0.13);
    g.fillRect(cx - 2, s.y + 11, measure(f, cmd) + 4, 11);
  }
  drawText(g, m, head, hx, s.y + 4, stutter ? mix(pink, C.ink, 0.7) : pink);
  drawText(g, f, cmd, cx, s.y + 13, cyan);
}

function tvScreen(g: CanvasRenderingContext2D, tv: Rect, t: number, b: Board) {
  const m = MICRO(), f = FONT();
  const shout = b.shouts.length ? b.shouts[b.shouts.length - 1] : null;
  const live = shout && t - shout.t0 < SHOUT_MS ? shout : null;
  r(g, tv.x, tv.y, tv.w, tv.h, C.ink2);
  for (let y = 0; y < tv.h; y += 2) r(g, tv.x, tv.y + y, tv.w, 1, mix(C.ink2, C.blue1, 0.5));
  drawText(g, m, "AGENT OFFICE", tv.x + 3, tv.y + 2, C.gold3);
  if (Math.floor(t / 600) % 2 === 0) r(g, tv.x + tv.w - 6, tv.y + 3, 3, 3, C.red3);
  const cols: [number, string, string][] = [[b.workers, "CREW", C.white], [b.tools, "TOOLS", C.blue5], [b.flips, "FLIPS", C.terra4]];
  const cw = Math.floor((tv.w - 4) / 3);
  cols.forEach(([n, label, c], i) => {
    const x = tv.x + 2 + i * cw;
    const s = n > 9999 ? (n / 1000).toFixed(0) + "K" : String(n);
    const big = measure(f, s) <= cw - 2;
    if (big) drawText(g, f, s, x + Math.floor((cw - measure(f, s)) / 2), tv.y + 9, c);
    else drawText(g, m, s, x + Math.floor((cw - measure(m, s)) / 2), tv.y + 11, c);
    drawText(g, m, label, x + Math.floor((cw - measure(m, label)) / 2), tv.y + 18, C.slate3);
  });
  const by = tv.y + tv.h - 13;
  const ink = live ? (BRAND_ART[live.agent] ?? BRAND_ART.claude).ink : C.ink;
  const text = live ? asciiOnly(live.text) || "!" : "";
  const age = live ? t - live.t0 : 0;
  if (live && age < SHOUT_HOLD_MS) {
    // The shout takes the whole screen first: the agent's mark and its words, still and centred.
    const flash = age < 900 && Math.floor(age / 150) % 2 === 0;
    r(g, tv.x, tv.y, tv.w, tv.h, flash ? mix(C.ink2, ink, 0.35) : C.ink2);
    for (let y = 0; y < tv.h; y += 2) r(g, tv.x, tv.y + y, tv.w, 1, rgba(C.blue1, 0.35));
    r(g, tv.x, tv.y, tv.w, 9, C.red1);
    drawText(g, m, "LIVE", tv.x + 3, tv.y + 2, C.white);
    if (Math.floor(t / 400) % 2 === 0) r(g, tv.x + 21, tv.y + 3, 3, 3, C.white);
    const lines = wrap(f, text, tv.w - 8, 2);
    const lg = logoMark(live.agent, 9);
    const top = tv.y + 12 + (lines.length === 1 ? 4 : 0);
    g.drawImage(lg.c, tv.x + Math.floor((tv.w - 9) / 2), top);
    lines.forEach((l, i) => drawText(g, f, l, tv.x + Math.floor((tv.w - measure(f, l)) / 2), top + 11 + i * 9, C.white));
    g.fillStyle = rgba(C.white, 0.05);
    g.fillRect(tv.x + tv.w - 24, tv.y, 9, tv.h);
    return;
  }
  if (live) {
    // then a red band under the counters: still if it fits, a ticker if it doesn't
    r(g, tv.x, by - 2, tv.w, 12, C.red1);
    r(g, tv.x, by - 2, 12, 12, C.red2);
    g.drawImage(logoMark(live.agent, 7).c, tv.x + 3, by);
    const tw = measure(f, text);
    const span = tv.w - 15;
    const x = tw <= span - 2 ? tv.x + 14 + Math.floor((span - tw) / 2) : tv.x + 14 + span - (((age - SHOUT_HOLD_MS) * 0.03) % (tw + span));
    g.save();
    g.beginPath();
    g.rect(tv.x + 13, by - 2, span, 12);
    g.clip();
    drawText(g, f, text, x, by, C.white);
    g.restore();
  } else {
    // per-brand mini counts for whoever is in, then the activity sparkline
    const ks = (Object.keys(b.byAgent) as AgentKind[]).filter((k) => b.byAgent[k] > 0).sort((a, c) => b.byAgent[c] - b.byAgent[a]).slice(0, 3);
    let x = tv.x + 3;
    for (const k of ks.length ? ks : (["claude", "commandcode", "codex"] as AgentKind[])) {
      const lg = pixelLogo(k as LogoKind, 5, (BRAND_ART[k] ?? BRAND_ART.claude).ink);
      g.drawImage(lg.c, x, by);
      const n = String(b.byAgent[k] ?? 0);
      drawText(g, m, n, x + 7, by, C.slate4);
      x += 10 + measure(m, n);
    }
    if (b.waiting) {
      // who is waiting on a human, instead of the sparkline: the office's to-do for the viewer
      const msg = `${b.waiting} NEED${b.waiting === 1 ? "S" : ""} YOU`;
      const mx = tv.x + tv.w - 4 - measure(m, msg);
      if (Math.floor(t / 700) % 2 === 0) r(g, mx - 5, by + 1, 3, 3, C.gold3);
      drawText(g, m, msg, mx, by, C.gold3);
      g.fillStyle = rgba(C.white, 0.05);
      g.fillRect(tv.x + tv.w - 24, tv.y, 9, tv.h);
      return;
    }
    const sx = Math.max(x + 2, tv.x + 50), sw = tv.x + tv.w - 3 - sx, sy = tv.y + tv.h - 5;
    const n = Math.min(b.spark.length, sw);
    const max = Math.max(3, ...b.spark.slice(-n));
    for (let i = 0; i < n; i++) {
      const v = b.spark[b.spark.length - n + i];
      const hgt = Math.max(v > 0 ? 1 : 0, Math.round((v / max) * 9));
      r(g, sx + i, sy - hgt, 1, hgt, i === n - 1 ? C.gold3 : C.green3);
    }
  }
  g.fillStyle = rgba(C.white, 0.05);
  g.fillRect(tv.x + tv.w - 24, tv.y, 9, tv.h);
}

/** The bitmap fonts are ASCII plus a few symbols; emoji and the like are dropped. */
export function asciiOnly(s: string): string {
  return s.replace(/[^\x20-\x7e·…→✓✗♥⌘]/gu, "").replace(/\s+/g, " ").trim();
}

/**
 * The wing's uplink tower and a fibre from it to every remote pod, with data
 * pulses running out to pods whose crews are busy. Drawn on the floor, under
 * the pods.
 */
export function drawFibres(g: CanvasRenderingContext2D, p: RoomPlan, blocks: Iterable<Block>, t: number, busy: (b: Block) => number) {
  const u = p.uplink;
  if (!u || !p.wing) return;
  for (const b of blocks) {
    if (b.zone !== "cloud" || b.alpha <= 0) continue;
    const kind = b.host?.kind && b.host.kind !== "local" ? b.host.kind : "ssh";
    const col = HOST_BRAND[kind].color;
    const px = Math.round(b.x) + 6, py = Math.round(b.y) + RUG_TOP - 2;
    const gy = Math.round(b.y) - 6;
    const pts: [number, number][] = [[u.x + 4, u.y + 2], [u.x + 4, gy], [px, gy], [px, py]];
    const dead = b.offline;
    g.globalAlpha = b.alpha;
    // the cable: a dark sheath with a thin lit core
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const xa = Math.min(x0, x1), ya = Math.min(y0, y1);
      const w = Math.abs(x1 - x0) + 1, h = Math.abs(y1 - y0) + 1;
      r(g, xa - (w === 1 ? 1 : 0), ya - (h === 1 ? 1 : 0), w + (w === 1 ? 2 : 0), h + (h === 1 ? 2 : 0), C.sv0);
      g.fillStyle = dead ? C.sv3 : rgba(col, 0.55);
      g.fillRect(xa, ya, w, h);
      len += w + h - 2;
    }
    // pulses
    const rate = dead ? 0 : busy(b);
    if (rate > 0) {
      const n = 1 + Math.round(rate * 3);
      for (let k = 0; k < n; k++) {
        let d = ((t * (0.05 + rate * 0.07) + k * (len / n) + hash(b.key) % 97) % len);
        for (let i = 1; i < pts.length; i++) {
          const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
          const seg = Math.abs(x1 - x0) + Math.abs(y1 - y0);
          if (d <= seg) {
            const f = seg ? d / seg : 0;
            const x = Math.round(x0 + (x1 - x0) * f), y = Math.round(y0 + (y1 - y0) * f);
            r(g, x - 1, y - 1, 3, 3, rgba(col, 0.45));
            r(g, x, y, 1, 1, C.white);
            break;
          }
          d -= seg;
        }
      }
    }
    g.globalAlpha = 1;
  }
}

/** The uplink tower at the wing's back wall: a column of light the fibres plug into. */
export function drawUplink(g: CanvasRenderingContext2D, p: RoomPlan, t: number, activity: number) {
  const u = p.uplink;
  if (!u) return;
  const x = u.x - 4, base = u.y + 6;
  const top = p.wing && p.wing.y === 0 ? 14 : u.y - 18;
  P.floorShadow(g, x - 1, base - 1, 18, 4);
  r(g, x, top, 16, base - top, C.sv1);
  r(g, x, top, 16, 2, C.sv4);
  r(g, x + 1, top + 2, 1, base - top - 2, C.sv3);
  r(g, x + 14, top + 2, 1, base - top - 2, C.sv0);
  // the light core breathes with the office's activity
  const h = base - top - 8;
  for (let i = 0; i < h; i++) {
    const ph = (Math.sin(t * (0.004 + activity * 0.01) - i * 0.25) + 1) / 2;
    r(g, x + 6, top + 4 + i, 4, 1, mix(C.sv3, C.cyan3, 0.25 + 0.75 * ph * (0.4 + activity * 0.6)));
  }
  r(g, x + 7, top + 4, 2, h, rgba(C.white, 0.25));
  r(g, x + 2, base - 4, 12, 2, C.sv0);
}

/** A pod's desks, scaled for the ASCII pass: which colour the edges and lettering get. */
export function podInk(b: Block): string {
  if (b.zone === "cloud") {
    const kind = b.host?.kind && b.host.kind !== "local" ? b.host.kind : "ssh";
    return HOST_BRAND[kind].color;
  }
  return (BRAND_ART[b.agent] ?? BRAND_ART.claude).ink;
}
