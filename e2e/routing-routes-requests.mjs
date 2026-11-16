import { Buffer } from "node:buffer";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe } from "./proxy-satellite.mjs";

const GENERIC = { message: "error.500.description" };
const CROSS_ORIGIN = { error: "Forbidden", reason: "missing or untrusted Origin header" };

/**
 * @param {import("node:http").IncomingMessage} request The request
 * @param {import("node:http").ServerResponse} response The response
 */
export function backend(request, response) {
  request.resume();
  const url = new URL(request.url, "http://backend.local");
  const base = `http://${request.headers.host}`;
  const send = (/** @type {number} */ status, /** @type {Record<string, string>} */ headers, /** @type {string} */ body) => {
    response.writeHead(status, headers);
    response.end(body);
  };
  switch (url.pathname) {
    case "/api/acme/denied":
      return send(403, { "content-type": "text/plain" }, "error.acme.denied");
    case "/api/acme/broken":
      return send(500, { "content-type": "text/plain" }, "internal stack trace");
    case "/api/acme/redirect":
      return send(302, { location: "/elsewhere" }, "");
    case "/api/acme/data":
      return send(200, { "content-type": "application/json" }, '{"data":true}');
    case "/api/acme/relay":
      return send(302, { location: `${base}/api/files/9`, "set-cookie": "rb=1; Path=/" }, "");
    case "/api/acme/relay-out":
      return send(302, { location: `${base}/exports/x` }, "");
    case "/api/acme/follow":
      return send(302, { location: `http://localhost:${url.port || request.headers.host.split(":")[1]}/api/acme/other-site` }, "");
    case "/api/acme/other-site":
      return send(200, { "content-type": "text/plain", "set-cookie": "site=other; Path=/" }, "other");
    default:
      return send(200, { "content-type": "application/json" }, '{"ok":true}');
  }
}

export const outcome = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => ({ status: answer.status, body: bodyJson(answer) });

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
export async function ownershipChecks(ctx, server, send) {
  const ping = await send("GET", "/api/_acme/ping");
  const head = await send("HEAD", "/api/_acme/ping");
  const post = await send("POST", "/api/_acme/ping");
  const bare = await exchange(server.url, { method: "POST", path: "/api/_acme/ping" });
  const options = await send("OPTIONS", "/api/_acme/ping");
  const slash = await send("GET", "/api/_acme/ping/");
  const multi = { put: await send("PUT", "/api/_acme/multi"), get: await send("GET", "/api/_acme/multi"), bare: await exchange(server.url, { method: "PUT", path: "/api/_acme/multi" }) };
  const page = await send("GET", "/acme-page");
  const pagePost = await send("POST", "/acme-page");
  observe(ctx, "a module route owns its path, whatever the method", { ping: outcome(ping), head: head.headers, post: outcome(post), options: outcome(options), multi: { put: outcome(multi.put), get: outcome(multi.get) }, backendRequests: server.backend.requests.map((seen) => seen.url) }, [
    ctx.equal("GET answers JSON 200", [ping.status, ping.headers["content-type"], ping.text], [200, "application/json", '{"ok":true}']),
    ctx.equal("the route answers before the /api/** proxy: the backend never saw it", server.backend.to("/api/_acme/ping").length, 0),
    ctx.equal("HEAD reaches the GET route without its body", [head.status, head.body.length, head.headers["content-type"], head.headers["cache-control"]], [200, 0, "application/json", "no-store"]),
    ctx.equal("a method the module does not declare answers 405 with Allow", [post.status, post.headers.allow, post.headers["content-type"], bodyJson(post)], [405, "GET, HEAD", "application/json", { message: "Method not allowed" }]),
    ctx.equal("405 comes before the Origin check", outcome(bare), { status: 405, body: { message: "Method not allowed" } }),
    ctx.equal("OPTIONS is 405 too", [options.status, options.headers.allow], [405, "GET, HEAD"]),
    ctx.equal("a trailing slash names the same route", [slash.status, slash.text], [200, '{"ok":true}']),
    ctx.equal("a path declared for two methods answers both and 405 the others", [multi.put.status, bodyJson(multi.put), multi.get.status, multi.get.headers.allow], [200, { method: "PUT" }, 405, "PUT, DELETE"]),
    ctx.equal("the state-changing method needs the Origin", outcome(multi.bare), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("a module route answers a page path", outcome(page), { status: 200, body: { page: "module" } }),
    ctx.equal("and not for other methods: 405, not the page's 404", pagePost.status, 405),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
export async function parameterChecks(ctx, server, send) {
  const params = {
    literal: await send("GET", "/api/_acme/items/new"),
    param: await send("GET", "/api/_acme/items/abc"),
    slash: await send("GET", "/api/_acme/items/a%2Fb"),
    utf8: await send("GET", "/api/_acme/items/%C3%A9t%C3%A9"),
    pair: await send("GET", "/api/_acme/pair/x/y"),
    fixed: await send("GET", "/api/_acme/o/fixed"),
    other: await send("GET", "/api/_acme/o/other"),
    tie: await send("GET", "/api/_acme/tie"),
    priority: await send("GET", "/api/_acme/ping"),
    rootParam: await send("GET", "/some-page-path"),
    deeper: await send("GET", "/some/deeper/path"),
  };
  observe(ctx, "paths, parameters and precedence", Object.fromEntries(Object.entries(params).map(([name, answer]) => [name, outcome(answer)])), [
    ctx.equal("a literal route is tried before a parameter route", bodyJson(params.literal), { item: "new" }),
    ctx.equal("a :name segment is decoded", bodyJson(params.param), { id: "abc" }),
    ctx.equal("%2F in a parameter decodes to a slash and stays one segment", bodyJson(params.slash), { id: "a/b" }),
    ctx.equal("UTF-8 escapes decode", bodyJson(params.utf8), { id: "été" }),
    ctx.equal("two parameters", bodyJson(params.pair), { a: "x", b: "y" }),
    ctx.equal("routes with fewer parameters come first, across modules", [bodyJson(params.fixed), bodyJson(params.other)], [{ owner: "zeta-fixed" }, { owner: "acme-param" }]),
    ctx.equal("of the same method and path the module of higher priority keeps it", bodyJson(params.priority), { ok: true }),
    ctx.equal("on equal priority the first module id wins", bodyJson(params.tie), { owner: "acme" }),
    ctx.equal("a route whose first segment is a parameter answers every page path of that shape", bodyJson(params.rootParam), { owner: "root-param" }),
    ctx.equal("a deeper path is the backend proxy's or a page's, not that route's", bodyJson(params.deeper)?.owner === "root-param", false),
  ]);

  /** @type {Record<string, import("./proxy-http.mjs").Exchange>} */
  const renderer = {};
  for (const path of ["/assets/mine", "/@mine", "/node_modules/mine"]) renderer[path] = await send("GET", path);
  observe(ctx, "the renderer's own paths are never a module's", Object.fromEntries(Object.entries(renderer).map(([path, answer]) => [path, outcome(answer)])), [
    ctx.equal("a route declared on /assets/, /@ or /node_modules/ is ignored: the renderer answers 404", Object.values(renderer).map((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.headers["content-type"]]), [[404, "text/plain"], [404, "text/plain"], [404, "text/plain"]]),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
export async function defaultChecks(ctx, server, send) {
  const defaults = {
    nothing: await send("GET", "/api/_acme/nothing"),
    nul: await send("GET", "/api/_acme/null"),
    response: await send("GET", "/api/_acme/response"),
    cache: await send("GET", "/api/_acme/default-cache"),
    empty: await send("POST", "/api/_acme/echo"),
    json: await send("POST", "/api/_acme/echo", { "content-type": "application/json" }, '{"a":[1,2]}'),
    invalid: await send("POST", "/api/_acme/echo", { "content-type": "application/json" }, "{nope"),
    noOrigin: await exchange(server.url, { method: "POST", path: "/api/_acme/echo", body: "{}" }),
    wrongOrigin: await exchange(server.url, { method: "POST", path: "/api/_acme/echo", headers: { origin: "https://evil.example" }, body: "{}" }),
    open: await exchange(server.url, { method: "POST", path: "/api/_acme/open" }),
  };
  observe(ctx, "the handler's answer and the defaults every route gets", Object.fromEntries(Object.entries(defaults).map(([name, answer]) => [name, { ...outcome(answer), headers: answer.headers }])), [
    ctx.equal("nothing and null answer an empty 204", [defaults.nothing.status, defaults.nothing.body.length, defaults.nul.status, defaults.nul.body.length], [204, 0, 204, 0]),
    ctx.equal("a returned Response keeps its status, its own headers and its own cache-control", [defaults.response.status, defaults.response.text, defaults.response.headers["x-own"], defaults.response.headers["cache-control"]], [201, "created", "1", "max-age=5"]),
    ctx.equal("a Response without cache-control gets no-store", defaults.cache.headers["cache-control"], "no-store"),
    ctx.equal("a JSON answer is no-store too", (await send("GET", "/api/_acme/ping")).headers["cache-control"], "no-store"),
    ctx.equal("readJson gives {} for an empty body", bodyJson(defaults.empty), { received: {} }),
    ctx.equal("readJson parses the body", bodyJson(defaults.json), { received: { a: [1, 2] } }),
    ctx.equal("a body that is not JSON answers 400", outcome(defaults.invalid), { status: 400, body: { message: "Invalid request body" } }),
    ctx.equal("a state-changing request without Origin answers 403", outcome(defaults.noOrigin), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("another site's Origin answers 403", outcome(defaults.wrongOrigin), { status: 403, body: CROSS_ORIGIN }),
    ctx.equal("sameOrigin: false needs no Origin", outcome(defaults.open), { status: 200, body: { open: true } }),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
export async function limitChecks(ctx, server, send) {
  const origin = { origin: server.url };
  /** @type {Record<string, import("./proxy-http.mjs").Exchange>} */
  const limits = {};
  for (const [name, path, size] of [["default 65536", "/api/_acme/size", 65536], ["default 65537", "/api/_acme/size", 65537], ["limit 10", "/api/_acme/small", 10], ["limit 11", "/api/_acme/small", 11], ["limit 9", "/api/_acme/small", 9]]) {
    limits[name] = await send("POST", path, { "content-type": "application/octet-stream" }, Buffer.alloc(size, 0x61));
  }
  /** @type {Record<number, import("./proxy-http.mjs").Exchange>} */
  const chunkedLimits = {};
  for (const size of [65536, 65537]) {
    chunkedLimits[size] = await exchange(server.url, { method: "POST", path: "/api/_acme/size", headers: { ...origin, "transfer-encoding": "chunked" }, chunks: [Buffer.alloc(size - 1000, 0x62), Buffer.alloc(1000, 0x62)] });
  }
  observe(ctx, "bodyLimit: 64 KiB by default, the route's own when set", { limits: Object.fromEntries(Object.entries(limits).map(([name, answer]) => [name, outcome(answer)])), chunked: Object.fromEntries(Object.entries(chunkedLimits).map(([name, answer]) => [name, outcome(answer)])) }, [
    ctx.equal("exactly 64 KiB passes", outcome(limits["default 65536"]), { status: 200, body: { bytes: 65536 } }),
    ctx.equal("one byte above is 413", outcome(limits["default 65537"]), { status: 413, body: { message: "Request body too large" } }),
    ctx.equal("a chunked body of exactly 64 KiB passes", outcome(chunkedLimits[65536]), { status: 200, body: { bytes: 65536 } }),
    ctx.equal("a chunked body one byte above is 413 too", chunkedLimits[65537]?.status, 413),
    ctx.equal("a route's bodyLimit: one below, at, above", [limits["limit 9"].status, limits["limit 10"].status, limits["limit 11"].status], [200, 200, 413]),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
export async function errorChecks(ctx, server, send) {
  const errors = {
    throws: await send("GET", "/api/_acme/throws"),
    plain: await send("GET", "/api/_acme/throws-plain"),
    denied: await send("GET", "/api/_acme/denied"),
    broken: await send("GET", "/api/_acme/broken"),
    redirected: await send("GET", "/api/_acme/redirected"),
  };
  observe(ctx, "an error the handler lets through is answered like a backend failure", Object.fromEntries(Object.entries(errors).map(([name, answer]) => [name, outcome(answer)])), [
    ctx.equal("a thrown error keeps its status, never its message", outcome(errors.throws), { status: 409, body: GENERIC }),
    ctx.equal("an error without a status is 502 with the generic message", outcome(errors.plain), { status: 502, body: GENERIC }),
    ctx.equal("a backend refusal keeps its status and its public error.* message", outcome(errors.denied), { status: 403, body: { message: "error.acme.denied" } }),
    ctx.equal("a backend failure with a private message is generic", outcome(errors.broken), { status: 500, body: GENERIC }),
    ctx.equal("event.backend does not follow a redirect: 502", outcome(errors.redirected), { status: 502, body: GENERIC }),
    ctx.equal("the technical cause stays out of every body", Object.values(errors).some((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => /secret|boom|stack/.test(answer.text)), false),
  ]);

}
