import { createReadStream, existsSync, statSync } from "node:fs";
import { extname } from "node:path";

/**
 * What a build or a module's `public/` directory may hold. A type missing
 * here went out as `application/octet-stream`: fonts among them, which a
 * browser then reports as a mismatch against the `font/woff2` it preloaded.
 *
 * @type {Record<string, string | undefined>}
 */
const MIME_TYPES = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".map": "application/json",
  ".mjs": "text/javascript",
  ".mp4": "video/mp4",
  ".otf": "font/otf",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webm": "video/webm",
  ".webmanifest": "application/manifest+json",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};
const DEFAULT_MIME_TYPE = "application/octet-stream";
/**
 * Vite names everything under `assets/` after its content: a new build
 * writes new names, so a client never needs to ask again.
 */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/**
 * Any other file keeps its name across builds (a module's `public/` file, a
 * favicon): the client asks again on each use, and is answered 304 while it
 * has not changed.
 */
const REVALIDATED_CACHE = "no-cache";

/** @param {string} path */
const isFile = (path) => existsSync(path) && statSync(path).isFile();

/**
 * The precompressed variant of `file` the client accepts, if the build wrote one.
 *
 * @param {string} file
 * @param {import("node:http").IncomingMessage} request
 */
function acceptedVariant(file, request) {
  const accepted = request.headers["accept-encoding"] ?? "";
  if (accepted.includes("br") && isFile(`${file}.br`))
    return { file: `${file}.br`, encoding: "br" };
  if (accepted.includes("gzip") && isFile(`${file}.gz`))
    return { file: `${file}.gz`, encoding: "gzip" };
  return { file, encoding: undefined };
}

/**
 * Weak, as the bytes of one representation are not compared: the size and
 * modification time of the file sent, so each encoding has its own.
 *
 * @param {import("node:fs").Stats} stats
 * @returns {string}
 */
function entityTag(stats) {
  return `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
}

/** @param {string} tag */
const opaqueTag = (tag) => tag.trim().replace(/^W\//, "");

/**
 * RFC 9110 §13.1.2 and §13.1.3: `If-None-Match` first, the date otherwise.
 *
 * The header has a one-second resolution.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {string} tag
 * @param {import("node:fs").Stats} stats
 * @returns {boolean}
 */
function isNotModified(request, tag, stats) {
  const noneMatch = request.headers["if-none-match"];
  if (noneMatch !== undefined) {
    if (noneMatch.trim() === "*") return true;
    const wanted = opaqueTag(tag);
    return noneMatch
      .split(",")
      .some((candidate) => opaqueTag(candidate) === wanted);
  }
  const since = Date.parse(request.headers["if-modified-since"] ?? "");
  return (
    !Number.isNaN(since) && Math.floor(stats.mtimeMs / 1000) * 1000 <= since
  );
}

/**
 * Send `file`, a file the caller already resolved and checked (see
 * `publicBuildFile`), as the variant the client accepts, or answer 304 when the
 * client's copy is current. `immutable` for a file named after its content.
 *
 * @param {string} file
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {{ immutable: boolean }} options
 */
export function serveStaticFile(file, request, response, { immutable }) {
  const selected = acceptedVariant(file, request);
  const stats = statSync(selected.file);
  const tag = entityTag(stats);
  /** @type {import("node:http").OutgoingHttpHeaders} */
  const headers = {
    "cache-control": immutable ? IMMUTABLE_CACHE : REVALIDATED_CACHE,
    etag: tag,
    "last-modified": stats.mtime.toUTCString(),
    vary: "Accept-Encoding",
  };
  if (isNotModified(request, tag, stats)) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  headers["content-type"] =
    MIME_TYPES[extname(file).toLowerCase()] ?? DEFAULT_MIME_TYPE;
  headers["content-length"] = stats.size;
  if (selected.encoding) headers["content-encoding"] = selected.encoding;
  response.writeHead(200, headers);
  if (request.method === "HEAD") response.end();
  else createReadStream(selected.file).pipe(response);
}
