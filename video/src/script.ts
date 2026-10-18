/*
 * What happens in the office, in world time (ms). One script for every cut:
 * the cuts only choose which stretches of it to film and from where. Every
 * project, file, command and model comes from the demo cast (src/demo/cast.ts).
 */
import { MOODS } from "../../src/demo/cast.ts";
import type { World } from "./world.ts";

/** World ms of each beat. */
export const T = {
  /** first worker out of the lift; the rest follow every `gap` */
  arrive: 300,
  gap: 520,
  /** the three poses: read, edit, search (each held ~3s) */
  read: 19_400,
  edit: 19_400,
  search: 19_400,
  /** the hero hands work to three interns */
  interns: 29_000,
  /** the hero's tests fail: the flip's t0 */
  flip: 58_000,
  /** first sandbox worker beams into the cloud wing (the wing appears) */
  cloud: 71_000,
  cloudGap: 160,
  /** a hand goes up: the amber "needs you" */
  waiting: 81_500,
  /** the README demo's stretch of the world starts here (after everything the launch video films) */
  readme: 104_000,
  readmeIntern: 117_900,
  readmeFlip: 121_300,
};

export function script(w: World) {
  // The opening cast, one desk per agent, in the order they walk out of the lift.
  const cast: [string, Parameters<World["persona"]>][] = [
    ["hero", ["claude", "api-gateway"]],
    ["codex", ["codex", "payments-svc"]],
    ["gemini", ["gemini", "ml-pipeline"]],
    ["cc", ["commandcode", "portfolio"]],
    ["opencode", ["opencode", "docs-site"]],
    ["cursor", ["cursor", "ascii"]],
    ["qwen", ["qwen", "data-etl"]],
    ["droid", ["droid", "auth-svc"]],
  ];
  cast.forEach(([name, args], i) => w.hire(name, w.persona(...args), T.arrive + i * T.gap, 6_000 + (i % 3) * 900));

  w.status("hero", 9_000, MOODS[0]!);

  // Three poses for the montage, held for the length of their shots.
  w.pose("gemini", T.read - 600, "read", "Read train.py", T.read + 4_000);
  w.pose("codex", T.edit - 600, "edit", "Edit ledger.go", T.edit + 4_000);
  w.pose("opencode", T.search - 600, "search", "Search *.mdx", T.search + 4_000);

  // Delegation: three interns walk in, the boss leans back.
  w.interns("hero", T.interns, ["Explore", "general-purpose", "Plan"], 11_000);
  w.resume("hero", T.interns + 17_500);

  // The money shot.
  w.flip("hero", T.flip);
  w.pass("hero", T.flip + 9_500);
  w.resume("hero", T.flip + 12_000);

  // The cloud wing: three sandboxes, three platforms.
  w.hire("daytona", w.persona("claude", "search-api", "daytona"), T.cloud, 3_200);
  w.hire("vercel", w.persona("gemini", "chat-bot", "vercel"), T.cloud + T.cloudGap, 3_200);
  w.hire("railway", w.persona("opencode", "edge-cache", "railway", 1), T.cloud + T.cloudGap * 2, 3_200);
  w.status("railway", T.cloud + 6_000, MOODS[4]!);

  // Somebody finishes and waits on you; you answer after the click.
  w.waiting("codex", T.waiting, 60_000);
  w.resume("codex", T.waiting + 9_000);

  // The README demo: an intern, then the flip, while the app is on screen.
  w.interns("hero", T.readmeIntern, ["Explore"], 5_000);
  w.flip("hero", T.readmeFlip);
  w.pass("hero", T.readmeFlip + 9_000);
  w.resume("hero", T.readmeFlip + 11_000);
}
