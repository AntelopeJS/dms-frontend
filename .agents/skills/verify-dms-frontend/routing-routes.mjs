import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { at } from "./json.mjs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { backend, outcome, ownershipChecks, parameterChecks, defaultChecks, limitChecks, errorChecks } from "./routing-routes-requests.mjs";

const SOURCE = readFileSync(new URL("./routing-fixture-routes.mjs", import.meta.url), "utf8");
const MANIFEST = JSON.stringify({ endpoints: [{ path: "/api/acme/events/*/*", methods: ["POST"] }], proxies: [] });
const MODULE_ROUTES = 42;
const OWN_ROUTES = 35;

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 */
function warningChecks(ctx, server) {
  const log = server.log();
  const lines = log.split("\n");
  const route = (method, path) => `"${method}${" "}${path}"`;
  const declares = (id, descriptor, reason) => `Frontend module ${id} declares route ${descriptor}, which is ignored: ${reason}.`;
  const reserved = "/api/_dms/, /@, /assets/, /node_modules/ are the renderer's own paths";
  const literal = (segment) => `"${segment}" is neither a literal segment nor a :name parameter`;
  const expectedWarnings = [
    `Frontend module @acme/shop serves ${route("GET", "/api/users")} from the frontend server, which hides whatever the backend serves there. Use a path under /api/_<module>/, or pass { overridesBackend: true } if that is the intent.`,
    `Frontend module @acme/shop serves ${route("GET", "/dms/thing")} from the frontend server, which hides whatever the backend serves there. Use a path under /api/_<module>/, or pass { overridesBackend: true } if that is the intent.`,
    `Frontend module @acme/shop serves ${route("POST", "/api/acme/events/:a/:b")}, a public endpoint a backend module declared: the module route answers it, not the backend.`,
    `${route("GET", "/api/_acme/ping")}: zeta/other (priority 5) is shadowed by @acme/shop (priority 10); the higher priority wins.`,
    `${route("GET", "/api/_acme/tie")}: beta/same (priority 10) is shadowed by @acme/shop (priority 10); same priority, the first module id wins.`,
    `${route("GET", "/api/_acme/o/fixed")} of zeta/other (priority 5) and ${route("GET", "/api/_acme/o/:x")} of @acme/shop (priority 10) can match the same request, which zeta/other answers: it has fewer parameters.`,
    `Frontend module @acme/shop serves ${route("GET", "/:anything")}, whose first segment is a parameter: it answers every path of that shape, the pages and other modules' routes included. Start the path with a literal segment.`,
    declares("@acme/shop", route("GET", "/assets/mine"), reserved),
    declares("@acme/shop", route("GET", "/api/_dms/mine"), reserved),
    declares("@acme/shop", route("GET", "/@mine"), reserved),
    declares("@acme/shop", route("GET", "/node_modules/mine"), reserved),
    declares("@acme/shop", route("FETCH", "/api/_acme/bad-method"), "the method is not one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
    declares("@acme/shop", route("GET", "api/_acme/no-slash"), "a path starts with /"),
    declares("@acme/shop", route("GET", "/api/_acme/with space"), literal("with space")),
    declares("@acme/shop", route("GET", "/api/_acme/../escape"), literal("..")),
    declares("@acme/shop", route("GET", "/api/_acme/dup/:x/:x"), "the parameter :x is repeated"),
    declares("@acme/shop", route("GET", "/api/_acme/no-handler"), "its handler is not a function"),
    declares("@acme/shop", route("GET", "/api/_acme/bad-limit"), "bodyLimit is not a byte count"),
    declares("@acme/shop", route("GET", "/api/_acme/bad-origin"), "sameOrigin is not a boolean"),
    declares("@acme/shop", route("GET", "/api/_acme/bad-options"), "its options are not an object"),
    "Frontend module bad/setup has a dms.server.ts that failed to declare its routes, which are ignored: boom in setup",
  ];
  observe(ctx, "every declaration problem is warned about, once, with the documented words", { warnings: lines.filter((line) => /Frontend module|shadowed|can match/.test(line)) }, [
    ctx.equal("each expected warning appears exactly once", expectedWarnings.map((text) => lines.filter((line) => line === text).length), expectedWarnings.map(() => 1)),
    ctx.equal("no other warning of these kinds", lines.filter((line) => /^Frontend module .* (serves|declares)|is shadowed by|can match the same request/.test(line)).length, expectedWarnings.length - 1),
    ctx.equal("a module route under /api/_<module>/ or with overridesBackend warns about nothing", lines.some((line) => /api\/_acme\/ping".*hides|api\/override".*hides/.test(line)), false),
    ctx.equal("the startup report counts the module routes", lines.find((line) => line.startsWith("Routing:")), `Routing: renderer files, then ${OWN_ROUTES + MODULE_ROUTES} module routes, then the backend proxies below, then the pages`),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
async function backendChecks(ctx, server, send) {
  const data = await send("GET", "/api/_acme/data", { "user-agent": "routing-agent", "x-content-language": "fr", "x-realtime-session": "rs", cookie: "a=b", authorization: "Bearer c" });
  const seenData = server.backend.to("/api/acme/data")[0];
  const relay = await send("GET", "/api/_acme/relay");
  const relayOut = await send("GET", "/api/_acme/relay-out");
  const follow = await send("GET", "/api/_acme/follow");
  const who = await send("GET", "/api/_acme/who");
  observe(ctx, "backend calls from a module route", { data: outcome(data), seen: seenData.headers, relay: relay.headers, relayOut: relayOut.headers, follow: { ...outcome(follow), headers: follow.headers }, who: outcome(who) }, [
    ctx.equal("event.backend returns the backend's JSON", outcome(data), { status: 200, body: { data: true } }),
    ctx.equal("it carries the client's address and the relayed client headers", [seenData.headers["x-forwarded-for"], seenData.headers["user-agent"], seenData.headers["x-content-language"], seenData.headers["x-realtime-session"]], ["127.0.0.1", "routing-agent", "fr", "rs"]),
    ctx.equal("it never carries the client's Cookie or Authorization", [seenData.headers.cookie ?? null, seenData.headers.authorization ?? null], [null, null]),
    ctx.equal("a relayed backend redirect on a proxied path becomes a frontend path, with the backend's cookie", [relay.status, relay.headers.location, relay.headers["set-cookie"]], [302, "/api/files/9", ["rb=1; Path=/"]]),
    ctx.equal("a redirect outside every proxy stays an absolute backend URL", [relayOut.status, relayOut.headers.location], [302, `${server.backend.url}/exports/x`]),
    ctx.equal("a fetch that followed a redirect to another site loses that site's cookies", [follow.status, follow.text, follow.headers["set-cookie"] ?? null], [200, "other", null]),
    ctx.equal("event.module is the module's id and its frozen, empty options; event.clientIp() is the socket's address", bodyJson(who), { module: { id: "@acme/shop", options: {}, privateOptions: {} }, endpoints: ["/api/auth/session-handoff"], isFrozen: true, ip: "127.0.0.1" }),
  ]);

}

/**
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {import("./proxy-satellite.mjs").Satellite} server The server
 * @param {(method: string, path: string, extra?: Record<string, string>, body?: string) => Promise<import("./proxy-http.mjs").Exchange>} send Sends a request with the server's own Origin
 */
async function cookieChecks(ctx, server, send) {
  const scope = createHash("sha256").update(server.backend.url).digest("hex").slice(0, 12);
  const written = await send("POST", "/api/_acme/cookie");
  const setCookie = [written.headers["set-cookie"]].flat();
  const value = /^[^=]+=([^;]+);/.exec(setCookie[0])?.[1] ?? "";
  const name = `-acme-shop.prefs_${scope}`;
  const readBack = await send("GET", "/api/_acme/cookie", { cookie: `${name}=${value}` });
  const renamed = await send("GET", "/api/_acme/cookie", { cookie: `prefs_${scope}=${value}` });
  const foreign = await send("GET", "/api/_zeta/cookie", { cookie: `${name}=${value}` });
  const zeta = await send("POST", "/api/_zeta/cookie");
  const myShop = await send("POST", "/api/_myshop/cookie");
  const cleared = await send("DELETE", "/api/_acme/cookie");
  const reserved1 = await send("GET", "/api/_acme/dms-cookie");
  const reserved2 = await send("GET", "/api/_acme/session-cookie");
  const invalidName = await send("GET", "/api/_acme/bad-cookie-name");
  const after = server.log();
  observe(ctx, "sealed cookies: scoped to the backend and the module, HttpOnly, SameSite=Lax, Secure", { written: setCookie, readBack: outcome(readBack), zeta: zeta.headers["set-cookie"], cleared: cleared.headers["set-cookie"] }, [
    ctx.equal("the cookie is named <module id>.<name>_<backend scope>, with the path and lifetime given", setCookie[0].replace(value, "VALUE"), `${name}=VALUE; Path=/x; HttpOnly; SameSite=Lax; Max-Age=60; Secure`),
    ctx.holds("its value is sealed: it does not contain the data", !value.includes("dark") && !Buffer.from(value, "base64url").toString("latin1").includes("dark"), value),
    ctx.equal("the module reads it back through its guard", bodyJson(readBack), { prefs: { theme: "dark" }, rejected: null }),
    ctx.equal("a cookie stored under the bare name is not read", bodyJson(renamed), { prefs: null, rejected: null }),
    ctx.equal("another module cannot read it", bodyJson(foreign), { prefs: null }),
    ctx.equal("each character of the module id outside A-Za-z0-9_- becomes a hyphen, the underscore and hyphen stay", [myShop.headers["set-cookie"]].flat()[0].replace(/=[^;]+;/, "=VALUE;"), `-acme-my_shop-x-y.prefs_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Secure`),
    ctx.equal("another module writes its own name", [zeta.headers["set-cookie"]].flat()[0].replace(/=[^;]+;/, "=VALUE;"), `zeta-other.prefs_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Secure`),
    ctx.equal("clear expires it", [cleared.headers["set-cookie"]].flat()[0], `${name}=; Path=/x; HttpOnly; SameSite=Lax; Max-Age=0; Secure`),
    ctx.equal("a dms_* name from a module that does not own sign-in, the session cookie's name and an invalid name each fail the route", [reserved1.status, reserved2.status, invalidName.status], [502, 502, 502]),
    ctx.equal("each failure names the reason in the server log", ["The dms_* cookies belong to the module that owns sign-in (antelopejs__dms-frontend-vue): choose another name than dms_flag", "The dms_session cookie is the session's: use event.session", "Invalid cookie name: bad name"].map((text) => after.includes(text)), [true, true, true]),
  ]);
}

export const journeys = [
  {
    id: "routing-routes",
    title: "module routes: who owns a path, 405 and HEAD, parameters, the defaults every route gets, errors, cookies, and every declaration problem warned about",
    entryPoint: "requests to a second `ajs dms start` whose server modules declare routes (a bundle shaped like `dist/server-modules`)",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      await withSatellite(ctx, { backend, modules: { source: SOURCE, keepOriginal: true }, files: { "generated-public-endpoints.json": MANIFEST } }, async (server) => {
        const origin = { origin: server.url };
        const send = (/** @type {string} */ method, /** @type {string} */ path, /** @type {Record<string, string>} */ extra = {}, /** @type {string} */ body) => exchange(server.url, { method, path, headers: { ...origin, ...extra }, body });
        warningChecks(ctx, server);
        await ownershipChecks(ctx, server, send);
        await parameterChecks(ctx, server, send);
        await defaultChecks(ctx, server, send);
        await limitChecks(ctx, server, send);
        await errorChecks(ctx, server, send);
        await backendChecks(ctx, server, send);
        await cookieChecks(ctx, server, send);
      });
    },
  },
  {
    id: "routing-client-ip",
    title: "event.clientIp() is the socket's address, the entry DMS_TRUSTED_PROXY_HOPS counts from the right of X-Forwarded-For, or the header DMS_CLIENT_IP_HEADER names",
    entryPoint: "GET /api/_acme/who with X-Forwarded-For on three servers started with different settings",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /**
       * @param {Record<string, string | undefined>} env The server's settings
       * @param {Record<string, string>} headers The request's headers
       * @returns {Promise<unknown>} The address the module route saw
       */
      const seen = (env, headers) =>
        withSatellite(ctx, { backend, modules: { source: SOURCE, keepOriginal: true }, files: { "generated-public-endpoints.json": MANIFEST }, env }, async (server) => {
          const answer = await exchange(server.url, { method: "GET", path: "/api/_acme/who", headers: { origin: server.url, ...headers } });
          return at(bodyJson(answer), "ip");
        });
      const chain = { "x-forwarded-for": "1.1.1.1, 2.2.2.2" };
      const untrusted = await seen({}, chain);
      const oneHop = await seen({ DMS_TRUSTED_PROXY_HOPS: "1" }, chain);
      const twoHops = await seen({ DMS_TRUSTED_PROXY_HOPS: "2" }, chain);
      const header = await seen({ DMS_CLIENT_IP_HEADER: "X-Client-IP" }, { ...chain, "x-client-ip": "203.0.113.9" });
      await ctx.verify("the client address follows the settings", [
        ctx.equal("no trusted hop: the socket's address, whatever X-Forwarded-For says", untrusted, "127.0.0.1"),
        ctx.equal("one trusted hop: the last entry before the socket's", oneHop, "2.2.2.2"),
        ctx.equal("two trusted hops: the one before", twoHops, "1.1.1.1"),
        ctx.equal("a named header wins over the chain", header, "203.0.113.9"),
      ]);
    },
  },
];
