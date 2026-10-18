/*
 * The landing page: copy buttons, the screenshot tabs, and the live office in
 * the hero. The office (site/office.ts: the real scene, demo and state, about
 * 85 KB gzipped) is a separate chunk, loaded once the page has painted; until
 * it runs, a still of it stands in. It pauses whenever it can't be seen
 * (scrolled away, hidden tab), and with prefers-reduced-motion it waits for
 * the visitor to press play. The legend below it plays its moments on hover,
 * or on a tap or Enter.
 */
import type { Moment, Office } from "./office.ts";

const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T | null;
const $$ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll(sel)] as T[];
const reduced = matchMedia("(prefers-reduced-motion: reduce)");
const canHover = matchMedia("(hover: hover) and (pointer: fine)");

/* ------------------------------------------------------------------ copy */

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:-100px;opacity:0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

for (const btn of $$<HTMLButtonElement>("[data-copy]")) {
  let t = 0;
  btn.addEventListener("click", async () => {
    const ok = await copyText(btn.dataset.copy ?? "");
    const status = btn.parentElement?.querySelector(".copied");
    btn.classList.toggle("is-copied", ok);
    if (status) status.textContent = ok ? "Copied to the clipboard" : "Couldn't copy; select the command instead";
    clearTimeout(t);
    t = window.setTimeout(() => {
      btn.classList.remove("is-copied");
      if (status) status.textContent = "";
    }, 1800);
  });
}

/* ------------------------------------------------------------------ tabs */

for (const box of $$("[data-tabs]")) {
  const tabs = $$<HTMLButtonElement>('[role="tab"]', box);
  const select = (tab: HTMLButtonElement, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  tabs.forEach((tab, i) => {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const k = e.key;
      const j = k === "ArrowRight" ? i + 1 : k === "ArrowLeft" ? i - 1 : k === "Home" ? 0 : k === "End" ? tabs.length - 1 : -1;
      if (j === -1) return;
      e.preventDefault();
      select(tabs[(j + tabs.length) % tabs.length]!, true);
    });
  });
}

/* ---------------------------------------------------------------- office */

const win = $("#office-window");
const mount = $("#office");
const caption = $("#caption");
const announce = $("#announce");
const playBtn = $<HTMLButtonElement>(".play");
let office: Office | null = null;
let loading: Promise<Office | null> | null = null;
let userPaused = false;
let inView = true;
let captionAt = 0;

function say(text: string, live = true) {
  if (caption) {
    caption.textContent = text;
    caption.classList.remove("flash");
    void caption.offsetWidth;
    caption.classList.add("flash");
  }
  if (live && announce) announce.textContent = text;
  captionAt = performance.now();
}

function load(): Promise<Office | null> {
  if (!mount || !win) return Promise.resolve(null);
  loading ??= import("./office.ts")
    .then(({ createOffice }) => {
      const o = createOffice(mount, { fastForward: 10_000, hour: 21.5 });
      o.onEvent((e) => {
        // the office's own big moments make the caption too, when the visitor isn't driving it
        if (performance.now() - captionAt < 6_000) return;
        if (e.kind === "test_fail") say(`${e.project}: a test failed and the table flipped (${e.summary ?? "tests"})`, false);
        else if (e.kind === "flip") say(`${e.project}: the agent flipped its own table, "${e.summary ?? ""}"`, false);
        else if (e.kind === "shout" && e.summary) say(`${e.project} on the office TV: ${e.summary.replace(/\s*\p{Extended_Pictographic}.*$/u, "")}`, false);
      });
      o.onSelect((w) => say(w ? w.text : "The real office, running its --demo in your browser.", false));
      office = o;
      (window as unknown as { __agentOffice?: Office }).__agentOffice = o;
      return o;
    })
    .catch((err) => {
      console.error(err);
      win.classList.add("is-broken");
      return null;
    });
  return loading;
}

function sync() {
  if (!office || !win) return;
  const want = !userPaused && inView && !document.hidden;
  if (want && !office.running) office.start();
  if (!want && office.running) office.pause();
  win.classList.toggle("is-live", office.running || win.classList.contains("is-live"));
  paintPause();
}

function paintPause() {
  if (!win) return;
  win.classList.toggle("is-paused", userPaused);
  const pause = $<HTMLButtonElement>('[data-toggle="pause"]', win);
  if (pause) {
    pause.setAttribute("aria-pressed", String(userPaused));
    pause.setAttribute("aria-label", userPaused ? "Play the office" : "Pause the office");
    pause.title = userPaused ? "Play" : "Pause";
  }
  if (playBtn) playBtn.hidden = !userPaused;
}

async function play() {
  userPaused = false;
  const o = await load();
  if (!o) return;
  sync();
}

if (win && mount) {
  userPaused = reduced.matches;
  paintPause();
  playBtn?.addEventListener("click", () => void play());

  const io = new IntersectionObserver(
    (entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (inView && !userPaused) void load().then(sync);
      else sync();
    },
    { rootMargin: "120px 0px" },
  );
  // Let the page paint first: the still is up, the office chunk can wait a beat.
  const begin = () => io.observe(win);
  if (document.readyState === "complete") setTimeout(begin, 60);
  else addEventListener("load", () => setTimeout(begin, 60), { once: true });
  document.addEventListener("visibilitychange", sync);

  /* toolbar */
  const setPressed = (sel: string, on: boolean) => $(sel, win)?.setAttribute("aria-pressed", String(on));
  const modeTo = (m: "pixel" | "ascii") => {
    for (const b of $$<HTMLButtonElement>("[data-mode]", win)) b.setAttribute("aria-pressed", String(b.dataset.mode === m));
    void load().then((o) => o?.setMode(m));
  };
  const toggles = { crt: false, stream: false };
  const toggle = (k: keyof typeof toggles, on = !toggles[k]) => {
    toggles[k] = on;
    setPressed(`[data-toggle="${k}"]`, on);
    void load().then((o) => (k === "crt" ? o?.setCrt(on) : o?.setDirector(on)));
  };
  for (const b of $$<HTMLButtonElement>("[data-mode]", win)) b.addEventListener("click", () => modeTo(b.dataset.mode as "pixel" | "ascii"));
  $('[data-toggle="crt"]', win)?.addEventListener("click", () => toggle("crt"));
  $('[data-toggle="stream"]', win)?.addEventListener("click", () => toggle("stream"));
  $('[data-toggle="pause"]', win)?.addEventListener("click", () => {
    if (userPaused) return void play();
    userPaused = true;
    sync();
  });
  for (const b of $$("[data-stream]")) {
    b.addEventListener("click", () => {
      toggle("stream", true);
      void play();
      (matchMedia("(min-width: 1200px)").matches ? $("#top") : win)?.scrollIntoView({ behavior: reduced.matches ? "auto" : "smooth", block: "start" });
    });
  }
  // The office's own keys, for the bits that make sense here.
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement;
    if (t.closest("input, textarea, select, [contenteditable]")) return;
    const k = e.key.toLowerCase();
    if (k === "a") modeTo($('[data-mode="ascii"]', win)?.getAttribute("aria-pressed") === "true" ? "pixel" : "ascii");
    else if (k === "c") toggle("crt");
    else if (k === "h") toggle("stream");
  });

  /* the legend */
  let hoverTimer = 0;
  let last: { m: string; id: string; at: number } | null = null;
  const fire = async (btn: HTMLButtonElement, focus: boolean, start: boolean) => {
    const m = btn.dataset.moment as Moment;
    // wiggling the mouse over one line plays it once, not on every re-entry
    if (!focus && last && last.m === m && performance.now() - last.at < 2_500) return;
    let o = office;
    if (start && (!o || !o.running)) {
      await play();
      o = office;
    }
    if (!o || !o.running) return;
    if (focus && last && last.m === m && performance.now() - last.at < 3_000) {
      // the hover already played it: a click just brings the camera in
      o.focus(last.id);
      return;
    }
    const fired = o.trigger(m, { focus });
    btn.classList.remove("fired", "busy");
    void btn.offsetWidth;
    clearTimeout(Number(btn.dataset.t));
    btn.dataset.t = String(window.setTimeout(() => btn.classList.remove("fired", "busy"), 2_600));
    if (fired) {
      last = { m, id: fired.workerId, at: performance.now() };
      btn.classList.add("fired");
      say(fired.text);
    } else {
      btn.classList.add("busy");
      say(m === "arrive" || m === "beam" ? "The office is full for now; try again in a moment." : "Everyone's in the middle of something; try again in a moment.");
    }
  };
  for (const btn of $$<HTMLButtonElement>(".moment")) {
    btn.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse" || !canHover.matches) return;
      clearTimeout(hoverTimer);
      hoverTimer = window.setTimeout(() => void fire(btn, false, false), 180);
    });
    btn.addEventListener("pointerleave", () => clearTimeout(hoverTimer));
    btn.addEventListener("click", () => {
      clearTimeout(hoverTimer);
      void fire(btn, true, true);
    });
  }
}
