/*
 * The sponsor credit: Command Code's own wordmark (docs/sponsors/command-code.dark.svg,
 * the light-ink version for a dark background), drawn as the vector it is.
 */
import WORDMARK from "../../docs/sponsors/command-code.dark.svg";
import { SANS } from "./band.ts";
import { clamp, ease, ramp } from "./type.ts";

let img: HTMLImageElement | null = null;
const ASPECT = 871 / 190;

export async function loadSponsor() {
  const i = new Image();
  i.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(WORDMARK as string)}`;
  await i.decode();
  img = i;
}

/** "Sponsored by" and the wordmark, `h` px tall, centred on (cx, y) or left-aligned at x. */
export function sponsorLine(g: CanvasRenderingContext2D, x: number, y: number, h: number, alpha: number, align: "center" | "left" | "right" = "center") {
  if (!img || alpha <= 0) return { w: 0 };
  const font = Math.round(h * 0.62);
  g.save();
  g.font = `500 ${font}px ${SANS}, sans-serif`;
  const label = "Sponsored by";
  const lw = g.measureText(label).width;
  const gap = Math.round(h * 0.45);
  const mw = Math.round(h * ASPECT);
  const w = lw + gap + mw;
  const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  g.globalAlpha = alpha;
  g.fillStyle = "#b8b4cc";
  g.textBaseline = "middle";
  g.fillText(label, x0, y + h / 2 + Math.round(h * 0.04));
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = "high";
  g.drawImage(img, Math.round(x0 + lw + gap), Math.round(y), mw, h);
  g.restore();
  return { w };
}

/** The tag in the top-right corner near the start: on a plate, sliding in and out. */
export function sponsorTag(g: CanvasRenderingContext2D, W: number, H: number, lt: number, dur: number) {
  const k = ease.outCubic(ramp(lt, 0.1, 0.45)) * (1 - ease.inCubic(ramp(lt, dur - 0.35, dur)));
  if (k <= 0) return;
  const portrait = H > W * 1.2;
  const h = Math.round(Math.min(W, H) * (portrait ? 0.042 : 0.036));
  const pad = Math.round(h * 0.55);
  const margin = Math.round(Math.min(W, H) * 0.045);
  g.save();
  g.font = `500 ${Math.round(h * 0.62)}px ${SANS}, sans-serif`;
  const w = g.measureText("Sponsored by").width + Math.round(h * 0.45) + Math.round(h * ASPECT);
  g.restore();
  const x1 = W - margin + Math.round((1 - k) * 40);
  const y = portrait ? Math.round(H * 0.06) : margin;
  g.save();
  g.globalAlpha = clamp(k, 0, 1) * 0.9;
  g.fillStyle = "rgba(14,13,22,0.92)";
  g.fillRect(x1 - w - pad * 2, y - pad, w + pad * 2, h + pad * 2);
  g.fillStyle = "rgba(242,242,242,0.25)";
  g.fillRect(x1 - w - pad * 2, y - pad, w + pad * 2, 2);
  g.restore();
  sponsorLine(g, x1 - pad, y, h, clamp(k, 0, 1), "right");
}
