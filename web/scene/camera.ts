/*
 * The camera: a world point at the centre of the canvas plus a zoom in device
 * pixels per art pixel. Auto mode keeps the whole room framed as it grows;
 * any wheel, pinch or drag switches to manual; focus() flies to a worker and
 * keeps following it until the user takes over. Motion is critically damped.
 */
import { clamp } from "./util.ts";

export interface Insets { top: number; right: number; bottom: number; left: number }

export class Camera {
  x = 0;
  y = 0;
  z = 3;
  tx = 0;
  ty = 0;
  tz = 3;
  mode: "auto" | "manual" | "follow" = "auto";
  followId: string | null = null;
  /** canvas size in device px */
  vw = 1;
  vh = 1;
  /** CSS px insets (UI panels), scaled by dpr when fitting */
  insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  /** Panels that come and go with a selection: framed around, never laid out for. */
  overlay: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
  dpr = 1;
  private snapped = false;

  /** The part of the canvas no UI panel covers, in device px. */
  private free(withOverlay = true) {
    const side = (k: keyof Insets) => (withOverlay ? Math.max(this.insets[k], this.overlay[k]) : this.insets[k]) * this.dpr;
    const il = side("left"), ir = side("right"), it = side("top"), ib = side("bottom");
    const aw = Math.max(50, this.vw - il - ir), ah = Math.max(50, this.vh - it - ib);
    return { aw, ah, cx: il + aw / 2, cy: it + ah / 2 };
  }

  /** Width / height of the area no panel covers. */
  freeAspect() {
    const { aw, ah } = this.free();
    return aw / ah;
  }

  /** The shape the office is packed for: the free area without the selection's panels. */
  layoutAspect() {
    const { aw, ah } = this.free(false);
    return aw / ah;
  }

  /** Zoom that frames the whole room in the free area. */
  fitZoom(room: { w: number; h: number }) {
    const pad = 10;
    const { aw, ah } = this.free();
    return clamp(Math.min(aw / (room.w + pad * 2), ah / (room.h + pad * 2)), 0.5, 14);
  }

  /**
   * Frame the room. On a screen narrower than the room (a phone held upright)
   * the empty floor at the sides is cropped, never the pods (`core`, their
   * x extent), so a small office fills the screen instead of a thin strip.
   */
  fit(room: { x: number; y: number; w: number; h: number }, core?: { x0: number; x1: number }) {
    const { aw, ah, cx: cxs, cy: cys } = this.free();
    if (core) {
      const pad = 10;
      const want = (aw / ah) * (room.h + pad * 2) - pad * 2;
      const w = clamp(want, core.x1 - core.x0, room.w);
      if (w < room.w - 1) {
        const mid = clamp((core.x0 + core.x1) / 2, room.x + w / 2, room.x + room.w - w / 2);
        room = { x: mid - w / 2, y: room.y, w, h: room.h };
      }
    }
    this.tz = this.fitZoom(room);
    // centre in the free area
    this.tx = room.x + room.w / 2 - (cxs - this.vw / 2) / this.tz;
    this.ty = room.y + room.h / 2 - (cys - this.vh / 2) / this.tz;
    if (!this.snapped) {
      this.x = this.tx; this.y = this.ty; this.z = this.tz;
      this.snapped = true;
    }
  }

  get minZoom() {
    return 0.5;
  }

  follow(x: number, y: number, zoom?: number) {
    if (zoom) this.tz = zoom;
    const { cx, cy } = this.free();
    this.tx = x - (cx - this.vw / 2) / this.tz;
    this.ty = y - (cy - this.vh / 2) / this.tz;
  }

  update(dt: number) {
    const k = 1 - Math.exp(-dt / 1000 * (this.mode === "manual" ? 14 : 5));
    // zoom in log space so it feels even
    const lz = Math.log(this.z), ltz = Math.log(this.tz);
    this.z = Math.exp(lz + (ltz - lz) * k);
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
  }

  toScreen(wx: number, wy: number): [number, number] {
    return [(wx - this.x) * this.z + this.vw / 2, (wy - this.y) * this.z + this.vh / 2];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.vw / 2) / this.z + this.x, (sy - this.vh / 2) / this.z + this.y];
  }

  /** Zoom by `f` keeping the world point under (sx, sy) still. */
  zoomAt(sx: number, sy: number, f: number) {
    this.mode = "manual";
    this.followId = null;
    const nz = clamp(this.tz * f, 0.8, 16);
    const [wx, wy] = [(sx - this.vw / 2) / this.tz + this.tx, (sy - this.vh / 2) / this.tz + this.ty];
    this.tz = nz;
    this.tx = wx - (sx - this.vw / 2) / nz;
    this.ty = wy - (sy - this.vh / 2) / nz;
  }

  panBy(dx: number, dy: number) {
    this.mode = "manual";
    this.followId = null;
    this.tx -= dx / this.tz;
    this.ty -= dy / this.tz;
    // pans should feel attached to the pointer
    this.x -= dx / this.z;
    this.y -= dy / this.z;
  }

  reset() {
    this.mode = "auto";
    this.followId = null;
  }
}
