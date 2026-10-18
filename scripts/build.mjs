// Bundles the CLI for node and the web app for the browser into dist/.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/web/assets", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // The PTY library is an optionalDependency with a native binary per platform: loaded at runtime, never inlined.
  external: ["@lydell/node-pty"],
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
chmodSync("dist/cli.js", 0o755);

await build({
  entryPoints: ["web/main.ts"],
  outfile: "dist/web/assets/app.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  loader: { ".svg": "text", ".css": "text" },
  logLevel: "warning",
});

cpSync("web/index.html", "dist/web/index.html");
if (existsSync("assets")) cpSync("assets", "dist/web/assets", { recursive: true });
