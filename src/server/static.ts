/*
 * Serves the built web app out of dist/web. Paths are resolved strictly:
 * anything with a dot segment, a backslash, a null byte, double encoding or
 * a dotfile is refused before it touches the filesystem, and the resolved
 * real path must still sit inside the web root (no symlink escapes).
 */
import { createReadStream, existsSync, realpathSync, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".webmanifest": "application/manifest+json",
};

export function contentType(file: string): string {
  return TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/**
 * dist/cli.js -> dist/web. Falls back to ../../dist/web so the server also
 * finds the bundle when run from src/server directly.
 */
export function defaultWebRoot(): string {
  const candidates = [new URL("./web/", import.meta.url), new URL("../../dist/web/", import.meta.url)];
  for (const c of candidates) {
    if (c.protocol !== "file:") continue;
    const dir = fileURLToPath(c);
    if (existsSync(resolve(dir, "index.html"))) return dir;
  }
  return candidates[0]!.protocol === "file:" ? fileURLToPath(candidates[0]!) : resolve("dist/web");
}

/**
 * Map a still-encoded URL path (relative to root, no leading slash) to an
 * absolute file path inside root, or null if it is anything but a plain
 * relative path.
 */
export function safeResolve(root: string, encoded: string): string | null {
  if (!encoded || encoded.includes("\0") || /%00/i.test(encoded)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    return null;
  }
  // A "%" left after one decode means double encoding; nothing we ship has one.
  if (/[\0\\%]/.test(decoded) || /[\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = decoded.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return null;
  const base = resolve(root);
  const full = resolve(base, ...segments);
  return full.startsWith(base + sep) ? full : null;
}

export interface ServeOptions {
  /** Cache-Control for this response. */
  cache: string;
  headers: Record<string, string>;
}

/**
 * Stream one file that safeResolve already vetted. Returns false (and writes
 * nothing) when it is not a regular file inside root, so the caller can 404.
 */
export function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  file: string,
  opts: ServeOptions,
): boolean {
  let st: Stats;
  try {
    st = statSync(file);
    if (!st.isFile()) return false;
    const realRoot = realpathSync(root);
    const real = realpathSync(file);
    if (!real.startsWith(realRoot + sep)) return false;
  } catch {
    return false;
  }

  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers: Record<string, string> = {
    ...opts.headers,
    "Content-Type": contentType(file),
    "Cache-Control": opts.cache,
    ETag: etag,
    "Last-Modified": st.mtime.toUTCString(),
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers["Content-Length"] = String(st.size);
  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  const stream = createReadStream(file);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
  return true;
}
