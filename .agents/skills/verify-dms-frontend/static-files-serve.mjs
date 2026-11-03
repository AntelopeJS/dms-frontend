import { Buffer } from "node:buffer";
import { statSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";

const CLIENT = "dist/client";
const TEXT = Buffer.from("static file content for the verification of the production server. ".repeat(40));
const IMMUTABLE = "public, max-age=31536000, immutable";
const MIME = {
  avif: "image/avif",
  css: "text/css",
  gif: "image/gif",
  html: "text/html; charset=utf-8",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  js: "text/javascript",
  json: "application/json",
  map: "application/json",
  mjs: "text/javascript",
  mp4: "video/mp4",
  otf: "font/otf",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  ttf: "font/ttf",
  txt: "text/plain; charset=utf-8",
  wasm: "application/wasm",
  webm: "video/webm",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  woff: "font/woff",
  woff2: "font/woff2",
  xml: "application/xml",
  xyz: "application/octet-stream",
  PNG: "image/png",
};

/** @returns {Record<string, string | Buffer>} The files added to the satellite's client build */
function files() {
  /** @type {Record<string, string | Buffer>} */
  const added = {
    [`${CLIENT}/assets/pre.js`]: TEXT,
    [`${CLIENT}/assets/pre.js.br`]: brotliCompressSync(TEXT),
    [`${CLIENT}/assets/pre.js.gz`]: gzipSync(TEXT),
    [`${CLIENT}/assets/gz-only.css`]: TEXT,
    [`${CLIENT}/assets/gz-only.css.gz`]: gzipSync(TEXT),
    [`${CLIENT}/assets/plain.txt`]: "plain",
    [`${CLIENT}/other/pre.js`]: TEXT,
    [`${CLIENT}/other/pre.js.br`]: brotliCompressSync(TEXT),
    [`${CLIENT}/.well-known/probe.txt`]: "well-known file",
    [`${CLIENT}/.well-known/sub/deep.txt`]: "deep well-known file",
    [`${CLIENT}/.well-known/sub/.hidden.txt`]: "MARK-hidden-below-well-known",
    [`${CLIENT}/assets/.well-known/nested.txt`]: "MARK-nested-well-known",
    [`${CLIENT}/.hidden/secret.txt`]: "MARK-secret",
    [`${CLIENT}/visible/.dot.txt`]: "MARK-dot-file",
    [`${CLIENT}/assets/.dot.js`]: "MARK-dot-asset",
    [`${CLIENT}/.vite/extra.json`]: "{\"MARK\":1}",
    [`${CLIENT}/.vite/extra.json.br`]: brotliCompressSync(Buffer.from("{\"MARK\":1}")),
    [`${CLIENT}/.vite/extra.json.gz`]: gzipSync(Buffer.from("{\"MARK\":1}")),
  };
  for (const extension of Object.keys(MIME)) added[`${CLIENT}/mime/file.${extension}`] = "x";
  return added;
}

/**
 * @param {string} workspace The workspace
 * @param {string} path A path of the client build
 * @returns {{ etag: string, modified: string, size: number }} The validators the server derives from the file
 */
function validators(workspace, path) {
  const stats = statSync(join(workspace, CLIENT, path));
  return {
    etag: `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`,
    modified: stats.mtime.toUTCString(),
    size: stats.size,
  };
}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
async function variantChecks(ctx, server, get) {
  const raw = validators(server.workspace, "assets/pre.js");
  const br = validators(server.workspace, "assets/pre.js.br");
  const gz = validators(server.workspace, "assets/pre.js.gz");

  const encodings = {
    br: await get("/assets/pre.js", { "accept-encoding": "br" }),
    gzip: await get("/assets/pre.js", { "accept-encoding": "gzip" }),
    both: await get("/assets/pre.js", { "accept-encoding": "gzip, deflate, br" }),
    none: await get("/assets/pre.js"),
    identity: await get("/assets/pre.js", { "accept-encoding": "identity" }),
    deflate: await get("/assets/pre.js", { "accept-encoding": "deflate" }),
    gzOnly: await get("/assets/gz-only.css", { "accept-encoding": "br, gzip" }),
    noVariant: await get("/assets/plain.txt", { "accept-encoding": "br, gzip" }),
  };
  const view = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.headers["content-encoding"] ?? null, answer.headers["content-length"], answer.headers.vary];
  observe(ctx, "the variant the client accepts is sent as it was built", Object.fromEntries(Object.entries(encodings).map(([name, answer]) => [name, { status: answer.status, headers: answer.headers }])), [
    ctx.equal("br: the .br file, Brotli-coded", [view(encodings.br), encodings.br.body.equals(brotliCompressSync(TEXT)) || encodings.br.body.length === br.size], [[200, "br", String(br.size), "Accept-Encoding"], true]),
    ctx.equal("gzip: the .gz file", view(encodings.gzip), [200, "gzip", String(gz.size), "Accept-Encoding"]),
    ctx.equal("Brotli wins when both are accepted", encodings.both.headers["content-encoding"], "br"),
    ctx.equal("no Accept-Encoding: the plain file, still Vary: Accept-Encoding", [view(encodings.none), encodings.none.body.equals(TEXT)], [[200, null, String(raw.size), "Accept-Encoding"], true]),
    ctx.equal("identity and an unsupported coding get the plain file", [encodings.identity.headers["content-encoding"] ?? null, encodings.deflate.headers["content-encoding"] ?? null], [null, null]),
    ctx.equal("a file with only a .gz is sent gzipped to a client that accepts br and gzip", encodings.gzOnly.headers["content-encoding"], "gzip"),
    ctx.equal("a file with no variant is sent plain whatever the client accepts", [encodings.noVariant.headers["content-encoding"] ?? null, encodings.noVariant.text], [null, "plain"]),
    ctx.equal("the coded bodies decode to the file", [encodings.br.body.length, encodings.gzip.body.length].every((length) => length > 0), true),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
async function cacheChecks(ctx, server, get) {
  const raw = validators(server.workspace, "assets/pre.js");
  const br = validators(server.workspace, "assets/pre.js.br");
  const gz = validators(server.workspace, "assets/pre.js.gz");
  const encodings = {
    none: await get("/assets/pre.js"),
    br: await get("/assets/pre.js", { "accept-encoding": "br" }),
    gzip: await get("/assets/pre.js", { "accept-encoding": "gzip" }),
  };
  const asset = encodings.none;
  const other = await get("/other/pre.js");
  const hashedHeaders = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.headers["cache-control"], answer.headers.etag, answer.headers["last-modified"]];
  observe(ctx, "cache headers: immutable under /assets/, revalidated elsewhere", { asset: asset.headers, other: other.headers }, [
    ctx.equal("a file under /assets/ is immutable with a weak ETag from its size and mtime and its Last-Modified", hashedHeaders(asset), [IMMUTABLE, raw.etag, raw.modified]),
    ctx.equal("each variant has its own ETag", [encodings.br.headers.etag, encodings.gzip.headers.etag], [br.etag, gz.etag]),
    ctx.equal("a file outside /assets/ is no-cache with the same validators", [other.headers["cache-control"], other.headers.etag, other.headers["last-modified"], other.status], ["no-cache", validators(server.workspace, "other/pre.js").etag, validators(server.workspace, "other/pre.js").modified, 200]),
    ctx.equal("the Brotli-coded copy of a file outside /assets/ is no-cache too", (await get("/other/pre.js", { "accept-encoding": "br" })).headers["cache-control"], "no-cache"),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
async function conditionalChecks(ctx, server, get) {
  const raw = validators(server.workspace, "assets/pre.js");
  const br = validators(server.workspace, "assets/pre.js.br");
  const strong = raw.etag.slice(2);
  const earlier = new Date(Date.parse(raw.modified) - 1000).toUTCString();
  const later = new Date(Date.parse(raw.modified) + 1000).toUTCString();
  const conditional = {
    weak: await get("/assets/pre.js", { "if-none-match": raw.etag }),
    strong: await get("/assets/pre.js", { "if-none-match": strong }),
    list: await get("/assets/pre.js", { "if-none-match": `"zzz", ${raw.etag}` }),
    star: await get("/assets/pre.js", { "if-none-match": "*" }),
    other: await get("/assets/pre.js", { "if-none-match": 'W/"nope"' }),
    otherEncoding: await get("/assets/pre.js", { "accept-encoding": "br", "if-none-match": raw.etag }),
    sameEncoding: await get("/assets/pre.js", { "accept-encoding": "br", "if-none-match": br.etag }),
    modifiedExact: await get("/assets/pre.js", { "if-modified-since": raw.modified }),
    modifiedLater: await get("/assets/pre.js", { "if-modified-since": later }),
    modifiedEarlier: await get("/assets/pre.js", { "if-modified-since": earlier }),
    modifiedGarbage: await get("/assets/pre.js", { "if-modified-since": "yesterday" }),
    tagWins: await get("/assets/pre.js", { "if-none-match": raw.etag, "if-modified-since": earlier }),
    tagMismatchWins: await get("/assets/pre.js", { "if-none-match": 'W/"nope"', "if-modified-since": later }),
    otherFile: await get("/other/pre.js", { "if-none-match": validators(server.workspace, "other/pre.js").etag }),
  };
  const code = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.body.length];
  observe(ctx, "conditional requests", Object.fromEntries(Object.entries(conditional).map(([name, answer]) => [name, { status: answer.status, headers: answer.headers }])), [
    ctx.equal("a matching weak ETag answers 304 without a body", code(conditional.weak), [304, 0]),
    ctx.equal("the 304 repeats the validators and cache headers", [conditional.weak.headers.etag, conditional.weak.headers["cache-control"], conditional.weak.headers["last-modified"], conditional.weak.headers.vary], [raw.etag, IMMUTABLE, raw.modified, "Accept-Encoding"]),
    ctx.equal("the strong form of the tag matches (weak comparison)", conditional.strong.status, 304),
    ctx.equal("one tag in a list is enough", conditional.list.status, 304),
    ctx.equal("* matches", conditional.star.status, 304),
    ctx.equal("another tag gets the file", code(conditional.other), [200, raw.size]),
    ctx.equal("the tag of the plain file does not match the Brotli variant", conditional.otherEncoding.status, 200),
    ctx.equal("the tag of the Brotli variant matches it", conditional.sameEncoding.status, 304),
    ctx.equal("If-Modified-Since equal to Last-Modified: 304", conditional.modifiedExact.status, 304),
    ctx.equal("If-Modified-Since later: 304", conditional.modifiedLater.status, 304),
    ctx.equal("If-Modified-Since one second earlier: the file", conditional.modifiedEarlier.status, 200),
    ctx.equal("an unparsable date gets the file", conditional.modifiedGarbage.status, 200),
    ctx.equal("If-None-Match decides over If-Modified-Since: a matching tag", conditional.tagWins.status, 304),
    ctx.equal("If-None-Match decides over If-Modified-Since: a mismatching tag", conditional.tagMismatchWins.status, 200),
    ctx.equal("a file outside /assets/ answers 304 too", conditional.otherFile.status, 304),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
async function headAndTypeChecks(ctx, server, get) {
  const gz = validators(server.workspace, "assets/pre.js.gz");
  const head = await get("/assets/pre.js", { "accept-encoding": "gzip" }, "HEAD");
  observe(ctx, "HEAD", head.headers, [ctx.equal("a HEAD answers the GET's headers without a body", [head.status, head.body.length, head.headers["content-encoding"], head.headers["content-length"], head.headers["content-type"]], [200, 0, "gzip", String(gz.size), "text/javascript"])]);

  /** @type {Record<string, string | string[] | undefined>} */
  const types = {};
  for (const extension of Object.keys(MIME)) types[extension] = (await get(`/mime/file.${extension}`)).headers["content-type"];
  const lower = await get("/mime/file.PNG");
  observe(ctx, "MIME types", types, [
    ctx.equal("each extension has its type, the extension compared in lower case, an unknown one is octet-stream", Object.entries(MIME).map(([extension]) => [extension, types[extension]]), Object.entries(MIME)),
    ctx.equal("fonts are font/*", [types.woff, types.woff2, types.otf, types.ttf], ["font/woff", "font/woff2", "font/otf", "font/ttf"]),
    ctx.equal("an upper-case extension", lower.headers["content-type"], "image/png"),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
async function privacyChecks(ctx, server, get) {
  const served = {
    wellKnown: await get("/.well-known/probe.txt"),
    wellKnownDeep: await get("/.well-known/sub/deep.txt"),
    wellKnownHidden: await get("/.well-known/sub/.hidden.txt"),
    wellKnownNested: await get("/assets/.well-known/nested.txt"),
    hiddenDir: await get("/.hidden/secret.txt"),
    dotFile: await get("/visible/.dot.txt"),
    dotAsset: await get("/assets/.dot.js"),
    manifest: await get("/.vite/manifest.json"),
    manifestBr: await get("/.vite/manifest.json.br", { "accept-encoding": "br" }),
    manifestGz: await get("/.vite/manifest.json.gz", { "accept-encoding": "gzip" }),
    extra: await get("/.vite/extra.json", { "accept-encoding": "br" }),
    extraBr: await get("/.vite/extra.json.br"),
    encodedDot: await get("/%2e%76ite/manifest.json"),
    encodedWellKnownSibling: await get("/%2ewell-known/probe.txt"),
  };
  const leaked = (/** @type {import("./proxy-http.mjs").Exchange} */ answer, /** @type {string} */ marker) => answer.text.includes(marker) || answer.headers.etag !== undefined || answer.headers["content-encoding"] !== undefined;
  observe(ctx, "dot segments are never built assets; a leading /.well-known/ is the exception", Object.fromEntries(Object.entries(served).map(([name, answer]) => [name, { status: answer.status, type: answer.headers["content-type"], etag: answer.headers.etag }])), [
    ctx.equal("a public file under /.well-known/ is served", [served.wellKnown.status, served.wellKnown.text, served.wellKnown.headers["content-type"], served.wellKnown.headers["cache-control"]], [200, "well-known file", "text/plain; charset=utf-8", "no-cache"]),
    ctx.equal("also below a sub-directory of it", [served.wellKnownDeep.status, served.wellKnownDeep.text], [200, "deep well-known file"]),
    ctx.equal("a dot file below it is not", leaked(served.wellKnownHidden, "MARK-hidden-below-well-known"), false),
    ctx.equal(".well-known is only exempt as the first segment", leaked(served.wellKnownNested, "MARK-nested-well-known"), false),
    ctx.equal("a dot directory is not served", leaked(served.hiddenDir, "MARK-secret"), false),
    ctx.equal("a dot file is not served", leaked(served.dotFile, "MARK-dot-file"), false),
    ctx.equal("a dot file under /assets/ is answered by the renderer's own 404", [served.dotAsset.status, served.dotAsset.headers["content-type"], served.dotAsset.text], [404, "text/plain", "Not found"]),
    ctx.equal("Vite's real manifest stays private, plain, Brotli and gzip copies alike", [served.manifest, served.manifestBr, served.manifestGz].map((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => leaked(answer, '"file"')), [false, false, false]),
    ctx.equal("so does any file under /.vite/, whatever the coding asked", [leaked(served.extra, "MARK"), leaked(served.extraBr, "MARK")], [false, false]),
    ctx.equal("an encoded dot is decoded before the check", leaked(served.encodedDot, '"file"'), false),
    ctx.equal("%2e decodes to the dot of .well-known: the same exception applies", [served.encodedWellKnownSibling.status, served.encodedWellKnownSibling.text], [200, "well-known file"]),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
async function traversalChecks(ctx, server, get) {
  /** @type {Record<string, import("./proxy-http.mjs").Exchange>} */
  const probes = {
    dotDot: await get("/assets/../../server.mjs"),
    encodedDotDot: await get("/assets/%2e%2e/%2e%2e/server.mjs"),
    encodedSlash: await get("/assets/..%2f..%2fserver.mjs"),
    backslash: await get("/assets/..%5c..%5cserver.mjs"),
    absolute: await get("/assets//etc/passwd"),
    nul: await get("/assets/pre.js%00.png"),
    directory: await get("/assets"),
    directorySlash: await get("/assets/"),
    missing: await get("/assets/missing.js"),
    malformed: await get("/assets/%E0%A4%A.js"),
    serverFile: await get("/server.mjs"),
    indexHtml: await get("/index.html"),
  };
  observe(ctx, "no way out of the client build", Object.fromEntries(Object.entries(probes).map(([name, answer]) => [name, { status: answer.status, type: answer.headers["content-type"], bytes: answer.body.length }])), [
    ctx.equal("none of the traversal forms serves server.mjs", ["dotDot", "encodedDotDot", "encodedSlash", "backslash", "serverFile"].map((name) => String(probes[name]?.text).includes("createServer")), [false, false, false, false, false]),
    ctx.equal("a double slash, a NUL and a directory serve no file", ["absolute", "nul", "directory", "directorySlash"].map((name) => probes[name]?.headers.etag ?? null), [null, null, null, null]),
    ctx.equal("a missing file under /assets/ is 404 text/plain Not found", [probes.missing.status, probes.missing.headers["content-type"], probes.missing.text], [404, "text/plain", "Not found"]),
    ctx.equal("a malformed escape under /assets/ serves nothing", [probes.malformed.status, probes.malformed.text], [404, "Not found"]),
    ctx.equal("the built document is a file like another: no-cache, text/html", [probes.indexHtml.status, probes.indexHtml.headers["content-type"], probes.indexHtml.headers["cache-control"]], [200, "text/html; charset=utf-8", "no-cache"]),
  ]);
}

export const journeys = [
  {
    id: "static-files-serve",
    title: "built files: pre-compressed variants, MIME types, cache headers, conditional requests, and the files that stay private",
    entryPoint: "GET/HEAD of built files on a second `ajs dms start` whose client build holds known files",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { backend: undefined, files: files() }, async (server) => {
        const get = (/** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}, method = "GET") => exchange(server.url, { method, path, headers });
        await variantChecks(ctx, server, get);
        await cacheChecks(ctx, server, get);
        await conditionalChecks(ctx, server, get);
        await headAndTypeChecks(ctx, server, get);
        await privacyChecks(ctx, server, get);
        await traversalChecks(ctx, server, get);
      });
    },
  },
];

export const qualityJourneys = [
  {
    id: "static-files-encoding-quality",
    title: "a pre-compressed copy is sent only to a client that accepts that coding",
    entryPoint: "GET of a built file with Accept-Encoding values that refuse a coding with q=0",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { files: files() }, async (server) => {
        const refused = await exchange(server.url, { path: "/assets/pre.js", headers: { "accept-encoding": "br;q=0, gzip" } });
        const onlyRefused = await exchange(server.url, { path: "/assets/pre.js", headers: { "accept-encoding": "gzip;q=0" } });
        observe(ctx, "codings refused with q=0", { refused: refused.headers, onlyRefused: onlyRefused.headers }, [
          ctx.equal("br;q=0, gzip gets the gzip copy", refused.headers["content-encoding"], "gzip"),
          ctx.equal("gzip;q=0 alone gets the plain file", onlyRefused.headers["content-encoding"] ?? null, null),
        ]);
      });
    },
  },
];
