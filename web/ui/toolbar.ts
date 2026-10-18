/*
 * The floating control pill at the bottom: render mode, CRT, capture,
 * fullscreen, stream mode, sound, feed and help. One shared tooltip element
 * follows hover and keyboard focus and shows each control's shortcut.
 */
import type { RenderMode } from "../contract.ts";
import { h, setText, svgEl } from "./dom.ts";
import { icon, type ToolbarIcon } from "./icons.ts";

export interface ToolbarActions {
  mode(m: RenderMode): void;
  crt(): void;
  shot(): void;
  rec(): void;
  full(): void;
  stream(): void;
  sound(): void;
  feed(): void;
  help(): void;
}

export interface Toolbar {
  el: HTMLElement;
  tip: HTMLElement;
  setMode(m: RenderMode): void;
  setCrt(on: boolean): void;
  setSound(on: boolean): void;
  setFeed(open: boolean): void;
  setFull(on: boolean): void;
  setRecording(on: boolean, ms?: number): void;
  setRecLeft(seconds: number): void;
}

export const RING_C = 2 * Math.PI * 16;

export function createToolbar(act: ToolbarActions): Toolbar {
  const tip = h("div", { class: "tip", attrs: { role: "tooltip", id: "ao-tip", hidden: true } });
  const tipText = h("span");
  const tipKey = h("kbd");
  tip.append(tipText, tipKey);

  function showTip(btn: HTMLElement): void {
    setText(tipText, btn.dataset.tip ?? "");
    setText(tipKey, btn.dataset.key ?? "");
    tipKey.hidden = !btn.dataset.key;
    tip.hidden = false;
    const r = btn.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const x = Math.min(window.innerWidth - tr.width - 8, Math.max(8, r.left + r.width / 2 - tr.width / 2));
    tip.style.left = `${x}px`;
    tip.style.top = `${r.top - tr.height - 10}px`;
  }
  const hideTip = () => {
    tip.hidden = true;
  };

  function button(name: string, ic: ToolbarIcon, label: string, key: string, onClick: () => void, toggle = false): HTMLButtonElement {
    const b = h(
      "button",
      {
        class: `tb tb-${name}`,
        attrs: { type: "button", "aria-label": label, "aria-keyshortcuts": key === "?" ? "Shift+?" : key, "aria-pressed": toggle ? "false" : undefined },
        on: { click: onClick },
      },
      icon(ic, 2),
    );
    b.dataset.tip = label;
    b.dataset.key = key;
    return b;
  }

  const pixel = h("button", { class: "seg-btn", text: "Pixel", attrs: { type: "button", "aria-pressed": "true" }, on: { click: () => act.mode("pixel") } });
  const ascii = h("button", { class: "seg-btn", text: "ASCII", attrs: { type: "button", "aria-pressed": "false" }, on: { click: () => act.mode("ascii") } });
  for (const b of [pixel, ascii]) {
    b.dataset.tip = b === pixel ? "Pixel art" : "ASCII mode";
    b.dataset.key = "A";
    b.setAttribute("aria-keyshortcuts", "A");
  }
  const seg = h("div", { class: "seg", attrs: { role: "group", "aria-label": "Render mode" } }, h("span", { class: "seg-thumb" }), pixel, ascii);

  const crt = button("crt", "crt", "CRT effect", "C", act.crt, true);
  const shot = button("shot", "camera", "Screenshot PNG", "S", act.shot);
  const rec = button("rec", "record", "Clip that: save the last 15s", "R", act.rec, true);
  const ring = svgEl("svg", { class: "ring", viewBox: "0 0 36 36", "aria-hidden": "true" });
  ring.append(svgEl("circle", { cx: 18, cy: 18, r: 16, "stroke-dasharray": RING_C.toFixed(2), "stroke-dashoffset": "0" }));
  const recLeft = h("span", { class: "rec-left", attrs: { "aria-hidden": "true" } });
  rec.append(ring, recLeft);
  const full = button("full", "fullscreen", "Fullscreen", "F", act.full, true);
  const stream = button("stream", "eye", "Stream mode: hide controls", "H", act.stream, true);
  const sound = button("sound", "soundOff", "Sound", "M", act.sound, true);
  const feed = button("feed", "feed", "Activity feed", "\\", act.feed, true);
  const help = button("help", "help", "Keyboard shortcuts", "?", act.help);
  if (!document.fullscreenEnabled) full.hidden = true;

  const sep = () => h("span", { class: "tb-sep", attrs: { "aria-hidden": "true" } });
  const el = h(
    "nav",
    { class: "toolbar glass", attrs: { "aria-label": "Controls" } },
    seg,
    sep(),
    crt,
    sep(),
    shot,
    rec,
    sep(),
    full,
    stream,
    sound,
    sep(),
    feed,
    help,
  );

  el.addEventListener("pointerover", (ev) => {
    const b = ev.target instanceof Element ? ev.target.closest<HTMLElement>("[data-tip]") : null;
    if (b) showTip(b);
  });
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focusin", (ev) => {
    const b = ev.target instanceof HTMLElement && ev.target.matches(":focus-visible") ? ev.target.closest<HTMLElement>("[data-tip]") : null;
    if (b) showTip(b);
  });
  el.addEventListener("focusout", hideTip);
  el.addEventListener("click", hideTip);

  const press = (b: HTMLElement, on: boolean) => b.setAttribute("aria-pressed", String(on));

  return {
    el,
    tip,
    setMode(m) {
      press(pixel, m === "pixel");
      press(ascii, m === "ascii");
      seg.dataset.mode = m;
    },
    setCrt: (on) => press(crt, on),
    setSound(on) {
      press(sound, on);
      sound.replaceChildren(icon(on ? "soundOn" : "soundOff", 2));
      sound.dataset.tip = on ? "Sound on" : "Sound off";
    },
    setFeed: (open) => press(feed, open),
    setFull: (on) => press(full, on),
    setRecording(on, ms = 10_000) {
      press(rec, on);
      rec.classList.toggle("is-recording", on);
      rec.style.setProperty("--rec-ms", `${ms}ms`);
      rec.dataset.tip = on ? "Stop recording" : "Clip that: save the last 15s";
      rec.firstElementChild?.replaceWith(icon(on ? "stop" : "record", 2));
      if (!on) setText(recLeft, "");
    },
    setRecLeft: (s) => setText(recLeft, String(s)),
  };
}
