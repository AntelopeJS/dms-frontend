import { observe } from "./proxy-satellite.mjs";

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(path: string, headers?: Record<string, string>, method?: string) => Promise<import("./proxy-http.mjs").Exchange>} get Requests a path of the server
 */
export async function privacyChecks(ctx, server, get) {
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
export async function traversalChecks(ctx, server, get) {
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
