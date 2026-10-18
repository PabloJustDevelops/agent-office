/*
 * Browser entry: inject the chrome's CSS, create the canvas scene, mount the
 * chrome around it and stream the office from GET /events.
 */
import css from "./ui/styles.css";
import { createOfficeScene } from "./scene/index.ts";
import { mountChrome } from "./ui/app.ts";
import { connect } from "./ui/connection.ts";

/* A constructed stylesheet is not inline CSS, so a strict CSP (no
 * 'unsafe-inline' for styles) still lets it apply. <style> is the fallback. */
function injectStyles(text: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    const style = document.createElement("style");
    style.textContent = text;
    document.head.append(style);
  }
}

function mountPoint(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement("div");
    el.id = id;
    document.body.append(el);
  }
  return el;
}

injectStyles(css);
const scene = createOfficeScene(mountPoint("office"));
const chrome = mountChrome(mountPoint("chrome"), scene);

connect("/events", {
  snapshot: (s) => chrome.load(s),
  event: (e) => chrome.apply(e),
  state: (s, retryInMs) => chrome.connection(s, retryInMs),
});
