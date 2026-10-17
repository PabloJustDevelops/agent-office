/*
 * The seam between the scene (web/scene/**, the canvas office) and the UI
 * chrome (web/ui/**, web/main.ts: HUD, feed, inspector, toolbar). The UI owns
 * the SSE connection and feeds events in; the scene owns everything drawn on
 * the canvas.
 */
import type { OfficeEvent, Snapshot, WorkerState } from "../src/shared/events.ts";

export type RenderMode = "pixel" | "ascii";

export interface OfficeScene {
  /** Replace the whole office with a snapshot (on connect / reconnect). */
  load(snapshot: Snapshot): void;
  /** Fold one live event in: move, animate, spawn or remove workers. */
  apply(event: OfficeEvent): void;
  setMode(mode: RenderMode): void;
  getMode(): RenderMode;
  /** CRT scanlines + bloom overlay. */
  setCrt(on: boolean): void;
  /** Called when the user clicks a worker (null when clicking empty floor). */
  onSelect(cb: (workerId: string | null) => void): void;
  /** Highlight a worker (from the feed or inspector), null clears. */
  select(workerId: string | null): void;
  /** Pan/zoom the camera so this worker is centred. */
  focus(workerId: string): void;
  /** The canvas, for PNG export and MediaRecorder capture. */
  readonly canvas: HTMLCanvasElement;
  destroy(): void;
}

/** Implemented in web/scene/index.ts. */
export type CreateOfficeScene = (mount: HTMLElement) => OfficeScene;

export type { OfficeEvent, Snapshot, WorkerState };
