/*
 * People and furniture in ASCII mode. Converting a 16 px sprite into a handful of
 * characters gives letter soup, so in ASCII each worker is stamped as a tiny
 * hand-made glyph figure instead, snapped to the character grid: o /#\ [_]
 * at a glance, a bigger .-. (_) /[#]\ when zoomed in. Poses follow the pixel
 * sprite (typing arms, a raised hand, a cheer, a walk cycle, the flip), the
 * torso wears the brand colour, the head the worker's own skin and hair.
 * Desks, monitors and intern benches are stamped too, as box-drawing glyphs
 * sized to the zoom (╔══╗ desks, ┌──┐ monitors filled ▓ in the colour of what
 * is on screen), instead of being sampled into punctuation.
 */
import type { Figure } from "./ascii.ts";
import type { Camera } from "./camera.ts";
import { C, HAIRS, SKINS, mix } from "./palette.ts";
import { brandInk, TP_MS, type Crew, type Worker } from "./workers.ts";
import { clamp } from "./util.ts";
import { DESK_W, LAPTOP_DX, SEAT_W, benchDX, deskTop } from "./layout.ts";
import { podInk } from "./room.ts";
import type { Screen } from "./props.ts";

type Rows = string[];

/** 3 x 3: head, body, legs (or the chair). */
const SMALL: Record<string, Rows> = {
  stand: [" o ", "/#\\", "/ \\"],
  sit: [" o ", "/#\\", "[_]"],
  type0: [" o ", "/#\\", "[_]"],
  type1: [" o ", "-#\\", "[_]"],
  type2: [" o ", "/#-", "[_]"],
  think: [" o?", "/#\\", "[_]"],
  sleep: [" oz", "/#\\", "[_]"],
  lean: ["\\o/", " # ", "[_]"],
  raise0: ["\\o ", " #\\", "/ \\"],
  raise1: [" o/", "/# ", "/ \\"],
  cheer0: ["\\o/", " # ", "/ \\"],
  cheer1: [" o ", "\\#/", "/ \\"],
  walk0: [" o ", "/#\\", "/ \\"],
  walk1: [" o ", "\\#/", " |\\"],
  carry: [" o ", "[#]", "/ \\"],
  grab: [" o ", "/#\\", "/ \\"],
  flip: ["\\o/", " # ", "/ \\"],
  pointR: [" o ", " #-", "/ \\"],
  pointL: [" o ", "-# ", "/ \\"],
};

/** 5 x 4: hair, face, body, legs (or the chair). */
const LARGE: Record<string, Rows> = {
  stand: [" .-. ", " (_) ", "/[#]\\", " / \\ "],
  sit: [" .-. ", " (_) ", "/[#]\\", " [_] "],
  type0: [" .-. ", " (_) ", "/[#]\\", " [_] "],
  type1: [" .-. ", " (_) ", "-[#]\\", " [_] "],
  type2: [" .-. ", " (_) ", "/[#]-", " [_] "],
  think: [" .-.?", " (_) ", "/[#]\\", " [_] "],
  sleep: [" .-.z", " (_) ", "/[#]\\", " [_] "],
  lean: ["\\.-./", " (_) ", " [#] ", " [_] "],
  raise0: ["\\.-. ", " (_) ", " [#]\\", " / \\ "],
  raise1: [" .-./", " (_) ", "/[#] ", " / \\ "],
  cheer0: ["\\.-./", " (_) ", " [#] ", " / \\ "],
  cheer1: [" .-. ", "\\(_)/", " [#] ", " / \\ "],
  walk0: [" .-. ", " (_) ", "/[#]\\", " / \\ "],
  walk1: [" .-. ", " (_) ", "\\[#]/", "  |\\ "],
  carry: [" .-. ", " (_) ", "[###]", " / \\ "],
  grab: [" .-. ", " (_) ", "-[#]-", " / \\ "],
  flip: ["\\.-./", " (_) ", " [#] ", " / \\ "],
  pointR: [" .-. ", " (_) ", " [#]-", " / \\ "],
  pointL: [" .-. ", " (_) ", "-[#] ", " / \\ "],
};

/** 7 x 6 for close-ups: hair, head, shoulders, torso, torso / legs, legs or chair. */
const XL: Record<string, Rows> = {
  stand: ["  .-.  ", " (   ) ", " _\\_/_ ", "/|###|\\", "  | |  ", " _| |_ "],
  sit: ["  .-.  ", " (   ) ", " _\\_/_ ", "/|###|\\", " |###| ", " [___] "],
  type0: ["  .-.  ", " (   ) ", " _\\_/_ ", "/|###|\\", " |###| ", " [___] "],
  type1: ["  .-.  ", " (   ) ", " _\\_/_ ", "-|###|\\", " |###| ", " [___] "],
  type2: ["  .-.  ", " (   ) ", " _\\_/_ ", "/|###|-", " |###| ", " [___] "],
  think: ["  .-. ?", " (   ) ", " _\\_/_ ", "/|###|\\", " |###| ", " [___] "],
  sleep: ["  .-. z", " (   ) ", " _\\_/_ ", "/|###|\\", " |###| ", " [___] "],
  lean: ["\\ .-. /", " (   ) ", "  \\_/  ", " |###| ", " |###| ", " [___] "],
  raise0: ["\\ .-.  ", " (   ) ", " _\\_/_ ", " |###|\\", "  | |  ", " _| |_ "],
  raise1: ["  .-. /", " (   ) ", " _\\_/_ ", "/|###| ", "  | |  ", " _| |_ "],
  cheer0: ["\\ .-. /", " (   ) ", "  \\_/  ", " |###| ", "  | |  ", " _| |_ "],
  cheer1: ["  .-.  ", "\\(   )/", "  \\_/  ", " |###| ", "  | |  ", " _| |_ "],
  walk0: ["  .-.  ", " (   ) ", " _\\_/_ ", "/|###|\\", "  / \\  ", " /   \\ "],
  walk1: ["  .-.  ", " (   ) ", " _\\_/_ ", "\\|###|/", "   |\\  ", "   | \\ "],
  carry: ["  .-.  ", " (   ) ", " _\\_/_ ", "[#####]", "  | |  ", " _| |_ "],
  grab: ["  .-.  ", " (   ) ", " _\\_/_ ", "-|###|-", "  | |  ", " _| |_ "],
  flip: ["\\ .-. /", " (   ) ", "  \\_/  ", " |###| ", "  | |  ", " _| |_ "],
  pointR: ["  .-.  ", " (   ) ", " _\\_/_ ", " |###|-", "  | |  ", " _| |_ "],
  pointL: ["  .-.  ", " (   ) ", " _\\_/_ ", "-|###| ", "  | |  ", " _| |_ "],
};

type Role = "hair" | "face" | "neck" | "torso" | "legs";
const ROLES: Record<number, Role[]> = {
  3: ["face", "torso", "legs"],
  4: ["hair", "face", "torso", "legs"],
  6: ["hair", "face", "neck", "torso", "torso", "legs"],
};

function poseKey(crew: Crew, w: Worker, now: number): string {
  const { pose, dir, frame } = crew.pose(w, now);
  switch (pose) {
    case "type": return `type${frame % 3}`;
    case "raise": return `raise${frame & 1}`;
    case "cheer": return `cheer${frame & 1}`;
    case "walk": return `walk${frame & 1}`;
    case "point": return dir === "left" ? "pointL" : "pointR";
    default: return pose;
  }
}

export function workerFigures(crew: Crew, cam: Camera, cell: { w: number; h: number }, now: number): Figure[] {
  const out: Figure[] = [];
  // how many cells a sprite covers decides the figure size
  const spriteCells = (16 * cam.z) / cell.w;
  const ws = [...crew.workers.values()].sort((a, b) => a.y - b.y);
  for (const w of ws) {
    if (w.gone || w.alpha < 0.5) continue;
    const k = spriteCells * (w.intern ? 0.8 : 1);
    const set = k >= 8.5 ? XL : k >= 5 ? LARGE : SMALL;
    const key = poseKey(crew, w, now);
    let rows = set[key] ?? set.stand;
    const [sx, sy] = cam.toScreen(w.x, w.y);
    const width = rows[0].length;
    const col = Math.round(sx / cell.w - width / 2);
    const row = Math.floor(sy / cell.h) - rows.length + 1;
    // beaming in or out: rows appear from the feet up
    if (w.tp) {
      const p = clamp((now - w.tp.t0) / TP_MS, 0, 1);
      const shown = Math.round((w.tp.out ? 1 - p : clamp((p - 0.15) / 0.7, 0, 1)) * rows.length);
      rows = rows.map((r, i) => (i >= rows.length - shown ? r : " ".repeat(r.length)));
    }
    const ink = brandInk(w.agent);
    const skin = SKINS[w.look.skin][0];
    const hair = HAIRS[w.look.hair][1];
    const trim = mix(ink, C.white, 0.35);
    const roles = ROLES[rows.length] ?? ROLES[3];
    const seated = rows[rows.length - 1].includes("[_");
    const colors = rows.map((r, j) => [...r].map((ch) => {
      if (ch === "?" || ch === "!") return C.gold3;
      if (ch === "z") return C.slate4;
      if (ch === "#") return w.intern ? trim : ink;
      const role = r.includes("#") ? "torso" : roles[j];
      switch (role) {
        case "hair": return ch === "\\" || ch === "/" ? skin : hair;
        case "face": return skin;
        case "neck": return ch === "_" ? trim : skin;
        case "torso": return ch === "|" || ch === "[" || ch === "]" ? trim : skin;
        default: return seated ? C.slate3 : C.slate4;
      }
    }));
    out.push({ col, row, rows, colors });
  }
  return out;
}

/** What a monitor shows, as the colour its ▓ fill takes. */
function screenColor(scr: Screen, agentInk: string): string {
  switch (scr) {
    case "off": return C.slate2;
    case "boot": return C.slate4;
    case "idle": return C.slate3;
    case "thinking": return C.plum3;
    case "edit": return C.blue5;
    case "bash": return C.green4;
    case "read": return C.slate5;
    case "search": case "todo": return C.gold3;
    case "web": return C.blue4;
    case "fail": case "error": return C.red3;
    case "pass": return C.green4;
    case "waiting": return agentInk;
    case "reply": return C.white;
    default: return C.plum3;
  }
}

const BUSY = new Set<Screen>(["edit", "bash", "reply", "search", "web", "read"]);

/** Desks, monitors and benches as box-drawing stamps, one Figure each. */
export function furnitureFigures(crew: Crew, cam: Camera, cell: { w: number; h: number }, now: number): Figure[] {
  const out: Figure[] = [];
  const at = (wx: number, wy: number): [number, number] => {
    const [sx, sy] = cam.toScreen(wx, wy);
    return [Math.round(sx / cell.w), Math.round(sy / cell.h)];
  };
  const fig = (col: number, row: number, rows: string[], color: (ch: string, i: number, j: number) => string) => {
    out.push({ col, row, rows, colors: rows.map((r, j) => [...r].map((ch, i) => color(ch, i, j))) });
  };
  /** A box w x h cells in double (desk) or single (monitor) lines, with an optional fill. */
  const box = (w: number, h: number, double: boolean, fill = " "): string[] => {
    const [tl, tr, bl, br, hz, vt] = double ? ["╔", "╗", "╚", "╝", "═", "║"] : ["┌", "┐", "└", "┘", "─", "│"];
    if (h <= 1) return [double ? tl + hz.repeat(Math.max(0, w - 2)) + tr : "[" + fill.repeat(Math.max(1, w - 2)) + "]"];
    const rows = [tl + hz.repeat(w - 2) + tr];
    for (let k = 0; k < h - 2; k++) rows.push(vt + fill.repeat(w - 2) + vt);
    rows.push(bl + hz.repeat(w - 2) + br);
    return rows;
  };
  for (const b of crew.layout.blocks.values()) {
    if (b.alpha < 0.5) continue;
    const wood = mix(podInk(b), C.slate3, b.offline ? 0.7 : 0.35);
    for (const st of b.stations) {
      const dx = Math.round(b.x + st.x), dy = deskTop(b, st);
      const occ = st.main ? crew.workers.get(st.main) : undefined;
      const flip = occ?.show?.kind === "flip" ? now - occ.show.t0 : -1;
      if (st.hot) { bench(dx, dy, st); continue; }
      // the desk: on its legs, or upside down in front of a worker who just flipped it
      const [c0, r0] = at(dx, dy + 1), [c1, r1] = at(dx + DESK_W, dy + 15);
      const n = Math.max(3, c1 - c0);
      if (flip >= 600 && flip < 4800) {
        if (flip >= 1100 && flip < 4300) {
          const [fc, fr] = at(dx, dy + 30);
          fig(fc, fr, ["┻" + "━".repeat(n - 2) + "┻"], () => C.red3);
        }
      } else {
        fig(c0, r0, box(n, Math.max(1, Math.min(3, r1 - r0)), true), () => wood);
      }
      // the monitor, filled with whatever is on screen
      if (flip < 600) {
        const [m0, q0] = at(dx + 6, dy - 13), [m1, q1] = at(dx + 30, dy + 1);
        const mw = Math.max(3, m1 - m0), mh = Math.max(1, Math.min(4, q1 - q0));
        const scr = crew.screenOf(occ, now);
        const col = screenColor(scr, occ ? brandInk(occ.agent) : C.slate3);
        const busy = BUSY.has(scr);
        const fillCh = scr === "off" ? "░" : "▓";
        const rows = box(mw, mh, false, fillCh);
        fig(m0, q0, rows, (ch, i, j) => {
          if (ch !== fillCh) return C.slate4;
          // a busy screen flickers column by column, like text scrolling past
          return busy && ((i + j + Math.floor(now / 160)) % 4 === 0) ? mix(col, C.ink, 0.45) : col;
        });
      }
      if (st.seats > 0) bench(dx, dy, st);
    }
    // the intern bench (or a shared hot desk): a laptop per seat on one long table
    function bench(dx: number, dy: number, st: (typeof b.stations)[number]) {
      const bx = dx + benchDX(st), seats = Math.max(1, st.seats);
      const [b0, s0] = at(bx, dy + 1), [b1, s1] = at(bx + seats * SEAT_W, dy + 15);
      fig(b0, s0, box(Math.max(3, b1 - b0), Math.max(1, Math.min(2, s1 - s0)), true), () => wood);
      for (let k = 0; k < seats; k++) {
        const id = st.interns[k];
        const o = id ? crew.workers.get(id) : undefined;
        const [l0, lr] = at(bx + LAPTOP_DX + k * SEAT_W, dy - 5), [l1] = at(bx + LAPTOP_DX + 10 + k * SEAT_W, dy - 5);
        const scr = o && !o.leaving ? crew.screenOf(o, now) : "off";
        const col = screenColor(scr, o ? brandInk(o.agent) : C.slate3);
        const lw = Math.max(2, l1 - l0);
        fig(l0, lr, ["[" + (scr === "off" ? "░" : "▓").repeat(Math.max(0, lw - 2)) + "]"], (ch) => (ch === "[" || ch === "]" ? C.slate4 : col));
      }
    }
  }
  return out;
}
