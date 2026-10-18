/*
 * Where everything sits. Every pod ("block") belongs to one project (or, in
 * the cloud wing, one remote host): two agents on the same repo share a pod,
 * each at a desk in its own colours, both marks on the sign. A pod is sized to its crew:
 * one desk per session, an intern bench that grows with its subagents, no
 * empty stations. A bench seats MAX_BENCH; a busy pod's overflow interns go
 * to a shared hot desk at the end of the pod (more hot desks as it grows), so
 * nobody is ever left standing. Pods are shelf-packed into rows in creation order, local
 * pods in the office, remote pods in the glass-walled cloud wing beside it
 * (below it on portrait screens). When a pod grows or shrinks the rows
 * reflow and pods glide to their new spots with their crews seated; empty
 * desks and benches linger a few seconds first so subagent waves don't make
 * the floor jitter. Seats are live views on their pod, so a seated worker
 * rides along. Coordinates are art pixels; y grows down, feet are anchors.
 */
import type { AgentKind, Host } from "../../src/shared/events.ts";
import { hash } from "./util.ts";

export const WALL_H = 78;
export const CORRIDOR_Y = WALL_H + 19;
/** Top edge of the first pod row. */
export const FLOOR_TOP = WALL_H + 30;
export const POD_H = 74;
export const ROW_GAP = 12;
export const POD_GAP = 16;
export const SIDE_MARGIN = 28;
export const BOTTOM_MARGIN = 16;
export const ROOM_MIN_W = 330;
/** Glass partition between the office and the cloud wing. */
export const PARTITION = 12;
export const WING_PAD = 24;

export const DESK_W = 36;
/** Desk top-left y, relative to the pod's top edge. */
export const DESK_DY = 28;
/** Feet of a seated worker, relative to the desk top. */
export const SEAT_DY = 26;
export const LANE_DY = 38;
/** Rug top, relative to the pod's top edge (the sign hangs above it). */
export const RUG_TOP = 18;
export const POD_PAD = 8;
export const BENCH_GAP = 4;
/** One intern place on a bench: a 10 px laptop and some elbow room. */
export const SEAT_W = 16;
/** A laptop's left edge inside its seat. */
export const LAPTOP_DX = (SEAT_W - 10) >> 1;
export const STATION_GAP = 8;
/** Seats on a main desk's own bench; more interns go to a hot desk. */
export const MAX_BENCH = 6;
/** Seats at one shared hot desk. */
export const MAX_HOT = 8;
export const MAX_STATIONS = 6;
/** Empty desks / bench seats linger this long before the pod shrinks. */
const DESK_LINGER = 5000;
const BENCH_LINGER = 14000;

export type Zone = "local" | "cloud";
export type SeatKind = "main" | "intern";
export type PodProp = "plant" | "cabinet" | "board" | "printer" | "server" | "cooler";
export type DecorKind = "lounge" | "pingpong" | "arcade" | "books" | "plants" | "beanbags" | "racks";

export interface Pt { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

export interface Station {
  main: string | null;
  /** A shared hot desk: a bench with no main desk, for the pod's overflow interns. */
  hot?: boolean;
  /** The agent at this desk (a project pod can mix agents). */
  agent?: AgentKind;
  interns: (string | null)[];
  /** Bench capacity; trailing free seats are trimmed after BENCH_LINGER. */
  seats: number;
  /** target / shown x offset inside the pod */
  ox: number;
  x: number;
  emptyAt: number;
  benchAt: number;
}

export interface Block {
  key: string;
  pos: number;
  zone: Zone;
  /** The pod's own brand (rug, sign colour): the first agent to sit here. */
  agent: AgentKind;
  /** Every agent with a desk here, in desk order (more than one: both marks on the sign). */
  mix: AgentKind[];
  project: string;
  host?: Host;
  label: string;
  /** shown position (glides) and target */
  x: number;
  y: number;
  tx: number;
  ty: number;
  w: number;
  stations: Station[];
  props: PodProp[];
  alpha: number;
  dying: boolean;
  offline: boolean;
  /** bumps whenever the pod's rug/sign must be repainted */
  rev: number;
}

export interface Decor { kind: DecorKind; x: number; y: number; w: number; seed: number }

const signW = (label: string, marks = 1) => 22 + [...label].length * 6 + (marks - 1) * MARK_STEP;
/** How far each extra mark on a shared pod's sign is stepped right. */
export const MARK_STEP = 8;
/** Room a cloud pod's sign needs for its platform tag ("RAILWAY ", 3x5 caps at 4 px a letter). */
const TAG_LEN: Record<string, number> = { ssh: 3, daytona: 7, boat: 4, railway: 7, vercel: 6 };
export const tagW = (b: { zone: Zone; host?: Host }) => (b.zone === "cloud" && b.host && b.host.kind !== "local" ? (TAG_LEN[b.host.kind] ?? 0) * 4 + 4 : 0);
const stationW = (s: Station) => (s.hot ? Math.max(1, s.seats) * SEAT_W : DESK_W + (s.seats ? BENCH_GAP + s.seats * SEAT_W : 0));
/** Where a station's bench starts, relative to the station. */
export const benchDX = (s: Station) => (s.hot ? 0 : DESK_W + BENCH_GAP);

/** A live view of a seat: positions follow the pod while it glides. */
export class Seat {
  constructor(readonly kind: SeatKind, readonly block: Block, readonly st: Station, readonly slot: number) {}
  get deskX() { return Math.round(this.block.x + this.st.x); }
  get deskY() { return Math.round(this.block.y) + DESK_DY; }
  get benchX() { return this.deskX + benchDX(this.st); }
  get laneY() { return this.deskY + LANE_DY; }
  get x() {
    if (this.kind === "intern") return this.benchX + (SEAT_W >> 1) + this.slot * SEAT_W;
    return this.deskX + DESK_W / 2;
  }
  get y() {
    if (this.kind === "intern") return this.deskY + SEAT_DY - 1;
    return this.deskY + SEAT_DY;
  }
  get remote() { return this.block.zone === "cloud"; }
}

export class Layout {
  blocks = new Map<string, Block>();
  decor: Decor[] = [];
  /** width / height the packer aims for (the camera's free area) */
  aspect = 16 / 10;
  /** portrait: the cloud wing goes below the office instead of beside it */
  tall = false;
  /** structural version: room size, pods added or removed */
  version = 0;
  /** bumps on every reflow, so walkers can re-route to their moved seats */
  packs = 0;
  main: Rect = { x: 0, y: 0, w: ROOM_MIN_W, h: FLOOR_TOP + POD_H + BOTTOM_MARGIN };
  wing: Rect | null = null;
  private seats = new Map<string, Seat>();
  private nextPos = 0;
  private dirty = true;
  private planKey = "";
  private settleRoom: Rect | null = null;

  /** Aim the packer at the screen's shape; small changes don't reflow. */
  setAspect(aspect: number, tall: boolean) {
    if (tall !== this.tall) { this.tall = tall; this.dirty = true; }
    if (Math.abs(Math.log(aspect / this.aspect)) > 0.18) { this.aspect = aspect; this.dirty = true; }
  }

  seatOf(id: string): Seat | undefined {
    return this.seats.get(id);
  }

  /* ----------------------------------------------------------- seating */

  private podFor(agent: AgentKind, project: string, host: Host | undefined, now: number): Block {
    if (host && host.kind !== "local") {
      const key = "host:" + host.id;
      const have = this.blocks.get(key);
      if (have) { have.dying = false; return have; }
      return this.newBlock(key, "cloud", agent, project, host, cloudLabel(host));
    }
    for (let n = 0; n < 20; n++) {
      const key = `local:${project}:${n}`;
      const b = this.blocks.get(key);
      if (!b) return this.newBlock(key, "local", agent, project, undefined, n ? `${project} ${n + 1}` : project);
      const desks = b.stations.filter((s) => !s.hot);
      if (desks.length < MAX_STATIONS || desks.some((s) => !s.main && !s.interns.some(Boolean))) {
        b.dying = false;
        return b;
      }
    }
    void now;
    return this.newBlock(`local:${project}:x${this.nextPos}`, "local", agent, project, undefined, project);
  }

  private newBlock(key: string, zone: Zone, agent: AgentKind, project: string, host: Host | undefined, label: string): Block {
    const b: Block = {
      key, pos: this.nextPos++, zone, agent, mix: [agent], project, host, label,
      x: NaN, y: NaN, tx: 0, ty: 0, w: 0, stations: [], props: [], alpha: 0, dying: false, offline: false, rev: 0,
    };
    this.blocks.set(key, b);
    this.dirty = true;
    return b;
  }

  allocMain(id: string, agent: AgentKind, project: string, host: Host | undefined, now: number): Seat {
    const have = this.seats.get(id);
    if (have) return have;
    const b = this.podFor(agent, project, host, now);
    let st = b.stations.find((s) => !s.hot && !s.main && !s.interns.some(Boolean));
    if (!st) {
      st = { main: null, interns: [], seats: 0, ox: 0, x: NaN, emptyAt: 0, benchAt: 0 };
      // desks first, the shared hot desks stay at the end of the pod
      const hot = b.stations.findIndex((s) => s.hot);
      b.stations.splice(hot < 0 ? b.stations.length : hot, 0, st);
      this.dirty = true;
    }
    st.main = id;
    st.agent = agent;
    this.remix(b);
    const s = new Seat("main", b, st, 0);
    this.seats.set(id, s);
    return s;
  }

  allocIntern(id: string, parentId: string, agent: AgentKind, project: string, host: Host | undefined, now: number): Seat {
    const have = this.seats.get(id);
    if (have) return have;
    const ps = this.seats.get(parentId);
    if (!ps || ps.kind !== "main") return this.allocMain(id, agent, project, host, now);
    const b = ps.block;
    // the parent's own bench, then any hot desk in the pod with room, then a new hot desk
    const benches = [ps.st, ...b.stations.filter((s) => s.hot)];
    let st: Station | undefined, slot = -1;
    for (const cand of benches) {
      const cap = cand.hot ? MAX_HOT : MAX_BENCH;
      for (let i = 0; i < cand.seats; i++) if (!cand.interns[i]) { slot = i; break; }
      if (slot < 0 && cand.seats < cap) { slot = cand.seats++; this.dirty = true; }
      if (slot >= 0) { st = cand; break; }
    }
    if (!st) {
      st = { main: null, hot: true, interns: [], seats: 1, ox: 0, x: NaN, emptyAt: 0, benchAt: 0 };
      b.stations.push(st);
      slot = 0;
      this.dirty = true;
    }
    st.interns[slot] = id;
    const s = new Seat("intern", b, st, slot);
    this.seats.set(id, s);
    return s;
  }

  /** Recount which agents sit in a pod; the sign is repainted when that changes. */
  private remix(b: Block) {
    const mix: AgentKind[] = [];
    for (const st of b.stations) if (st.main && st.agent && !mix.includes(st.agent)) mix.push(st.agent);
    if (!mix.length) mix.push(b.agent);
    if (mix.join() !== b.mix.join()) {
      b.mix = mix;
      b.rev++;
      this.dirty = true;
    }
  }

  /** A worker took over another one in place (OfficeEvent.replaces): same seat, new id. */
  rename(from: string, to: string) {
    const s = this.seats.get(from);
    if (!s || this.seats.has(to)) return;
    this.seats.delete(from);
    this.seats.set(to, s);
    if (s.kind === "main") s.st.main = to;
    else s.st.interns[s.slot] = to;
  }

  free(id: string, now: number) {
    const s = this.seats.get(id);
    if (!s) return;
    this.seats.delete(id);
    if (s.kind === "main") { s.st.main = null; s.st.emptyAt = now; this.remix(s.block); }
    else {
      s.st.interns[s.slot] = null;
      s.st.benchAt = now;
      if (s.st.hot && !s.st.interns.some(Boolean)) s.st.emptyAt = now;
    }
  }

  clear() {
    this.blocks.clear();
    this.seats.clear();
    this.decor = [];
    this.dirty = true;
    this.version++;
  }

  setOffline(hostId: string, offline: boolean, now: number) {
    const b = this.blocks.get("host:" + hostId);
    if (!b || b.offline === offline) return;
    b.offline = offline;
    b.rev++;
    this.dirty = true;
    // back online: a ghost desk kept for the dark pod may now be cleared away
    if (!offline) for (const st of b.stations) if (st.emptyAt === Infinity) st.emptyAt = now;
  }

  /** An empty, dimmed pod for a remote that dropped while nobody worked there. */
  ghostHost(host: Host, agent: AgentKind) {
    const key = "host:" + host.id;
    if (this.blocks.has(key)) return;
    const b = this.newBlock(key, "cloud", agent, host.name, host, cloudLabel(host));
    b.offline = true;
    b.stations.push({ main: null, interns: [], seats: 0, ox: 0, x: NaN, emptyAt: Infinity, benchAt: 0 });
  }

  /* ------------------------------------------------------------ update */

  /** Trim lingering empties, reflow if needed, glide pods. */
  update(dt: number, now: number) {
    for (const b of this.blocks.values()) {
      const used = (st: Station) => !!st.main || st.interns.some(Boolean) || [...this.seats.values()].some((v) => v.st === st);
      const keep = b.stations.filter((st) => used(st) || now - st.emptyAt < DESK_LINGER || (b.offline && b.zone === "cloud"));
      if (keep.length !== b.stations.length) { b.stations = keep; this.dirty = true; }
      for (const st of b.stations) {
        let last = 0;
        for (let i = 0; i < st.seats; i++) if (st.interns[i]) last = i + 1;
        if (last < st.seats && now - st.benchAt > BENCH_LINGER) {
          st.seats = last;
          st.interns.length = Math.min(st.interns.length, last);
          this.dirty = true;
        }
      }
      if (!b.stations.length && !b.dying) { b.dying = true; this.dirty = true; }
    }
    if (this.dirty) this.pack();
    const k = 1 - Math.exp(-dt / 140);
    let moving = false;
    for (const b of [...this.blocks.values()]) {
      if (isNaN(b.x)) { b.x = b.tx; b.y = b.ty; }
      b.x += (b.tx - b.x) * k;
      b.y += (b.ty - b.y) * k;
      if (Math.abs(b.tx - b.x) < 0.3) b.x = b.tx;
      if (Math.abs(b.ty - b.y) < 0.3) b.y = b.ty;
      if (b.x !== b.tx || b.y !== b.ty) moving = true;
      for (const st of b.stations) {
        if (isNaN(st.x)) st.x = st.ox;
        st.x += (st.ox - st.x) * k;
        if (Math.abs(st.ox - st.x) < 0.3) st.x = st.ox;
        else moving = true;
      }
      b.alpha = Math.max(0, Math.min(1, b.alpha + (b.dying ? -1 : 1) * dt / 260));
      if (b.dying && b.alpha <= 0) {
        this.blocks.delete(b.key);
        this.dirty = true;
      }
    }
    if (!moving && this.settleRoom) {
      this.settleRoom = null;
      this.version++;
    }
  }

  /* -------------------------------------------------------------- pack */

  private pack() {
    this.dirty = false;
    this.packs++;
    const before = this.room();
    const live = [...this.blocks.values()].filter((b) => !b.dying).sort((a, b) => a.pos - b.pos);
    for (const b of live) this.sizeBlock(b);
    const local = live.filter((b) => b.zone === "local");
    const cloud = live.filter((b) => b.zone === "cloud");

    const shelf = (bs: Block[], maxW: number) => {
      const rows: Block[][] = [];
      let row: Block[] = [], w = 0;
      for (const b of bs) {
        if (row.length && w + POD_GAP + b.w > maxW) { rows.push(row); row = []; w = 0; }
        w += (row.length ? POD_GAP : 0) + b.w;
        row.push(b);
      }
      if (row.length) rows.push(row);
      const rowW = rows.map((r) => r.reduce((a, b, i) => a + b.w + (i ? POD_GAP : 0), 0));
      return { rows, w: Math.max(0, ...rowW), rowW };
    };
    const floorH = (n: number) => (n ? n * POD_H + (n - 1) * ROW_GAP : POD_H);
    const total = (bs: Block[]) => bs.reduce((a, b) => a + b.w, 0) + Math.max(0, bs.length - 1) * POD_GAP;
    const widest = (bs: Block[]) => Math.max(0, ...bs.map((b) => b.w));
    /** For each row count, the narrowest packing that fits in that many rows. */
    const variants = (bs: Block[]) => {
      const out: ReturnType<typeof shelf>[] = [];
      for (let k = 1; k <= Math.max(1, bs.length); k++) {
        let lo = widest(bs), hi = Math.max(lo, total(bs));
        while (hi - lo > 2) {
          const mid = Math.floor((lo + hi) / 2);
          if (shelf(bs, mid).rows.length <= k) hi = mid;
          else lo = mid;
        }
        const p = shelf(bs, hi);
        if (!out.some((q) => q.rows.length === p.rows.length)) out.push(p);
      }
      return out;
    };

    type Wing = ReturnType<typeof shelf> & { W: number; H: number };
    type Plan = ReturnType<typeof shelf> & { W: number; H: number; wing: Wing | null; score: number; key: string };
    const plans: Plan[] = [];
    const wingOpts = cloud.length ? variants(cloud) : [null];
    for (const p of variants(local)) {
      const W = Math.max(ROOM_MIN_W, p.w + SIDE_MARGIN * 2);
      const mainH = FLOOR_TOP + floorH(p.rows.length) + BOTTOM_MARGIN;
      for (const wp of wingOpts) {
        let wing: Wing | null = null;
        let TW = W, H = mainH, balance = 0;
        if (wp && this.tall) {
          const t = shelf(cloud, Math.max(widest(cloud), W - WING_PAD * 2));
          wing = { ...t, W, H: 26 + floorH(t.rows.length) + BOTTOM_MARGIN };
          H += wing.H;
        } else if (wp) {
          wing = { ...wp, W: wp.w + WING_PAD * 2, H: FLOOR_TOP + floorH(wp.rows.length) + BOTTOM_MARGIN };
          TW = W + PARTITION + wing.W;
          H = Math.max(mainH, wing.H);
          balance = Math.abs(Math.log(mainH / wing.H)) * 0.2;
        }
        const score = Math.abs(Math.log(TW / H / this.aspect)) + balance;
        plans.push({ ...p, W, H, wing, score, key: `${p.rows.length}:${wing?.rows.length ?? 0}` });
      }
    }
    let best = plans.reduce((a, b) => (b.score < a.score ? b : a));
    const prev = plans.find((p) => p.key === this.planKey);
    if (prev && prev.score < best.score + 0.14) best = prev;
    this.planKey = best.key;

    // place the office rows, left-aligned, with decor where a row ends early
    const mainW = best.W;
    const decor: Decor[] = [];
    best.rows.forEach((row, ri) => {
      let x = SIDE_MARGIN;
      const y = FLOOR_TOP + ri * (POD_H + ROW_GAP);
      for (const b of row) { this.place(b, x, y); x += b.w + POD_GAP; }
      this.fillDecor(decor, x, mainW - SIDE_MARGIN, y, ri);
    });
    const mainH = this.tall && best.wing ? best.H - best.wing.H : best.H;
    // a short office next to a tall wing: lounge rows below
    for (let ri = best.rows.length; ri < 40; ri++) {
      const y = FLOOR_TOP + ri * (POD_H + ROW_GAP);
      if (y + POD_H > mainH - BOTTOM_MARGIN) break;
      this.fillDecor(decor, SIDE_MARGIN, mainW - SIDE_MARGIN, y, ri);
    }
    this.decor = decor;
    this.main = { x: 0, y: 0, w: mainW, h: mainH };
    const wing = best.wing;
    if (wing) {
      const wx = this.tall ? 0 : mainW + PARTITION;
      const wy0 = this.tall ? this.main.h + 26 : FLOOR_TOP;
      const wingRight = wx + wing.W - WING_PAD;
      wing.rows.forEach((row, ri) => {
        let x = wx + WING_PAD;
        const y = wy0 + ri * (POD_H + ROW_GAP);
        for (const b of row) { this.place(b, x, y); x += b.w + POD_GAP; }
        if (wingRight - x >= 40) decor.push({ kind: "racks", x: x + 6, y, w: wingRight - x - 6, seed: hash(`w${ri}`) });
      });
      // the rest of the wing is the data centre: rows of racks
      const bottom = (this.tall ? this.main.h + wing.H : best.H) - BOTTOM_MARGIN;
      for (let ri = wing.rows.length; ri < 40; ri++) {
        const y = wy0 + ri * (POD_H + ROW_GAP);
        if (y + POD_H > bottom) break;
        decor.push({ kind: "racks", x: wx + WING_PAD, y, w: wing.W - WING_PAD * 2, seed: hash(`w${ri}`) });
      }
      this.wing = this.tall
        ? { x: 0, y: this.main.h, w: mainW, h: wing.H }
        : { x: wx, y: 0, w: wing.W, h: best.H };
    } else {
      this.wing = null;
    }
    const after = this.room();
    if (after.w !== before.w || after.h !== before.h || after.x !== before.x) {
      // grow at once; shrink only after the pods have glided inside
      const shrinking = after.w < before.w || after.h < before.h;
      this.settleRoom = shrinking ? union(before, this.settleRoom ?? before) : null;
      this.version++;
    }
  }

  private place(b: Block, x: number, y: number) {
    b.tx = x;
    b.ty = y;
    if (isNaN(b.x)) { b.x = x; b.y = y; }
  }

  /** Stations, props and the width they need. */
  private sizeBlock(b: Block) {
    let x = POD_PAD;
    for (const st of b.stations) {
      st.ox = x;
      if (isNaN(st.x)) st.x = x;
      x += stationW(st) + STATION_GAP;
    }
    const content = x - STATION_GAP + POD_PAD;
    const sign = signW(b.label, b.zone === "local" ? Math.min(3, b.mix.length) : 1) + tagW(b) + (b.offline ? 40 : 0);
    let w = Math.max(content, Math.min(sign, 160), 58);
    // a lived-in pod: fill spare rug with something, never an empty desk
    const spare = w - content;
    const props: PodProp[] = [];
    const h = hash(b.key);
    if (b.zone === "cloud") {
      if (spare >= 14) props.push("server");
      if (spare >= 30) props.push("server");
    } else {
      const pool: PodProp[] = ["plant", "board", "cabinet", "printer", "cooler", "plant"];
      let left = spare;
      let i = 0;
      while (left >= 16 && props.length < 3) {
        const p = pool[(h + i * 7) % pool.length];
        const pw = PROP_W[p];
        if (pw <= left - 2) { props.push(p); left -= pw + 3; }
        else if (left >= PROP_W.plant + 2) { props.push("plant"); left -= PROP_W.plant + 3; }
        else break;
        i++;
      }
    }
    if (w !== b.w || props.join() !== b.props.join()) b.rev++;
    b.w = w;
    b.props = props;
  }

  private fillDecor(out: Decor[], x0: number, x1: number, y: number, row: number) {
    const order: [DecorKind, number][] = [["lounge", 96], ["pingpong", 78], ["arcade", 50], ["books", 40], ["beanbags", 40], ["plants", 22]];
    let x = x0 + 10;
    let i = row * 3;
    let guard = 0;
    while (x1 - x >= 22 && guard++ < 12) {
      const room = x1 - x;
      let pick: [DecorKind, number] | null = null;
      for (let j = 0; j < order.length; j++) {
        const cand = order[(i + j) % order.length];
        if (cand[1] <= room) { pick = cand; break; }
      }
      if (!pick) break;
      out.push({ kind: pick[0], x, y, w: pick[1], seed: hash(`${row}:${x}`) });
      x += pick[1] + 14;
      i++;
    }
  }

  /** The whole floor plan (office plus wing); held big while pods glide in after a shrink. */
  room(): Rect {
    let r: Rect = { ...this.main };
    if (this.wing) r = union(r, this.wing);
    if (this.settleRoom) r = union(r, this.settleRoom);
    return r;
  }

  /** An aisle to walk down from the corridor to a pod's lane without crossing other pods. */
  aisleFor(s: Seat): number {
    const b = s.block;
    const left = this.main.x + SIDE_MARGIN / 2;
    const right = this.main.x + this.main.w - SIDE_MARGIN / 2;
    const cands = [b.tx - POD_GAP / 2, b.tx + b.w + POD_GAP / 2, left, right].sort((a, c) => Math.abs(a - s.x) - Math.abs(c - s.x));
    const y1 = s.laneY;
    for (const x of cands) {
      let ok = x > this.main.x + 4 && x < this.main.x + this.main.w - 4;
      for (const o of this.blocks.values()) {
        if (!ok) break;
        if (o.zone !== "local" || o.ty >= b.ty) continue;
        if (x > o.tx - 2 && x < o.tx + o.w + 2 && y1 > o.ty) ok = false;
      }
      if (ok) return x;
    }
    return left;
  }
}

/** A sandbox's name for its pod sign, without the id suffix some platforms add ("api:8c1d2e" -> "api"). */
export function cloudLabel(host: Host): string {
  return (host.name || host.kind).replace(/:[0-9a-f]{6}$/i, "") || host.kind;
}

export const PROP_W: Record<PodProp, number> = { plant: 14, cabinet: 12, board: 22, printer: 16, server: 12, cooler: 10 };

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Manhattan route: corridor, down an aisle that misses other pods, along the lane, into the chair. */
export function routeToSeat(layout: Layout, from: Pt, s: Seat): Pt[] {
  const ax = layout.aisleFor(s);
  return [
    { x: from.x, y: CORRIDOR_Y },
    { x: ax, y: CORRIDOR_Y },
    { x: ax, y: s.laneY },
    { x: s.x, y: s.laneY },
    { x: s.x, y: s.y },
  ];
}

export function routeFromSeat(layout: Layout, s: Seat, to: Pt): Pt[] {
  const ax = layout.aisleFor(s);
  return [
    { x: s.x, y: s.laneY },
    { x: ax, y: s.laneY },
    { x: ax, y: CORRIDOR_Y },
    { x: to.x, y: CORRIDOR_Y },
    { x: to.x, y: to.y },
  ];
}
