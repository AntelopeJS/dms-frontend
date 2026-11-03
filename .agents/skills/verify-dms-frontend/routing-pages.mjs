import { networkInterfaces } from "node:os";
import { createServer } from "node:net";
import { at, keysOf, numberAt, rowAt, textAt } from "./json.mjs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { freePort, observe, sleep, startSatellite, withSatellite } from "./proxy-satellite.mjs";
import { cookieHeader, setCookies } from "./proxy-signin.mjs";

const html = { accept: "text/html" };
const inertia = { "x-inertia": "true" };

/**
 * @param {string} url The frontend
 * @param {{ email: string, password: string }} credentials The administrator
 * @returns {Promise<string>} The Cookie header of the signed-in browser
 */
async function adminCookie(url, credentials) {
  const answer = await exchange(url, {
    method: "POST",
    path: "/auth/login",
    headers: { origin: url, "content-type": "application/json" },
    body: JSON.stringify({ email: credentials.email, password: credentials.password, keep_login: true }),
  });
  if (answer.status !== 200) throw new Error(`sign-in answered ${answer.status}: ${answer.text}`);
  return cookieHeader(setCookies(answer));
}

/**
 * @returns {string | undefined} An IPv4 address of this machine that is not loopback
 */
function externalAddress() {
  return Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal)?.address;
}

export const journeys = [
  {
    id: "routing-pages",
    title: "pages: the homepage redirect, signed-out visits to private pages, 404 for other methods, malformed paths, backend routes outside every prefix, asset version conflicts",
    entryPoint: "document and Inertia requests to the run's frontend, signed out and as the administrator",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const web = ctx.state.webUrl;
      const cookie = await adminCookie(web, ctx.adminCredentials());

      const home = await exchange(web, { path: "/", headers: html });
      const homeInertia = await exchange(web, { path: "/", headers: { ...inertia } });
      const homePost = await exchange(web, { method: "POST", path: "/", headers: { origin: web } });
      observe(ctx, "a visit to / goes to the configured homepage", { home: home.headers, inertia: homeInertia.headers, post: bodyJson(homePost) }, [
        ctx.equal("a document visit is redirected with 302 to the homepage", [home.status, home.headers.location, home.headers.vary], [302, "/examples/overview", "X-Inertia"]),
        ctx.equal("an Inertia visit is redirected the same way", [homeInertia.status, homeInertia.headers.location], [302, "/examples/overview"]),
        ctx.equal("a POST to / is not a page request: 404", [homePost.status, bodyJson(homePost)], [404, { message: "Not found" }]),
      ]);

      /** @type {Record<string, { status: number, type: string | string[] | undefined, body: unknown }>} */
      const methods = {};
      for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const answer = await exchange(web, { method, path: "/examples/overview", headers: { origin: web, cookie } });
        methods[method] = { status: answer.status, type: answer.headers["content-type"], body: bodyJson(answer) };
      }
      const head = await exchange(web, { method: "HEAD", path: "/examples/overview", headers: { ...html, cookie } });
      const getPage = await exchange(web, { path: "/examples/overview", headers: { ...html, cookie } });
      observe(ctx, "on a page path only GET and HEAD are served", { methods, head: head.headers, get: { status: getPage.status, headers: getPage.headers } }, [
        ctx.equal("every other method answers 404 with the JSON not-found body", Object.values(methods).map((entry) => [entry.status, entry.type, entry.body]), Object.keys(methods).map(() => [404, "application/json", { message: "Not found" }])),
        ctx.equal("GET renders the page with the private default cache", [getPage.status, getPage.headers["content-type"], getPage.headers["cache-control"], getPage.headers.vary], [200, "text/html", "private, no-cache", "X-Inertia, Accept-Encoding"]),
        ctx.equal("HEAD answers like GET without a body", [head.status, head.body.length, head.headers["cache-control"]], [200, 0, "private, no-cache"]),
      ]);

      const layout = await exchange(web, { path: "/examples/overview/pagelayout", headers: { ...html, cookie } });
      const layoutJson = await exchange(web, { path: "/examples/overview/pagelayout", headers: { accept: "application/json", cookie } });
      const unknownJson = await exchange(web, { path: "/examples/overview/zzz-unknown", headers: { accept: "application/json", cookie } });
      const layoutPost = await exchange(web, { method: "POST", path: "/examples/overview/pagelayout", headers: { origin: web, cookie } });
      observe(ctx, "a backend route outside every declared prefix is not reachable from the browser", { layout: layout.status, layoutJson: layoutJson.headers["content-type"], layoutPost: layoutPost.status }, [
        ctx.equal("<page>/pagelayout is a page path: an HTML 404", [layout.status, layout.headers["content-type"]], [404, "text/html"]),
        ctx.equal("asked for JSON it answers exactly as any other unknown page does", [layoutJson.status, layoutJson.text], [unknownJson.status, unknownJson.text]),
        ctx.equal("a POST there is the not-found JSON", [layoutPost.status, bodyJson(layoutPost)], [404, { message: "Not found" }]),
      ]);

      const settings = await exchange(web, { path: "/settings", headers: html });
      const settingsQuery = await exchange(web, { path: "/settings?tab=a%20b&x=1", headers: html });
      const settingsInertia = await exchange(web, { path: "/settings", headers: inertia });
      const auth = await exchange(web, { path: "/auth", headers: html });
      const authChild = await exchange(web, { path: "/auth/anything", headers: html });
      observe(ctx, "a signed-out visit to a private page goes to sign-in with ?redirect=", { settings: settings.headers.location, query: settingsQuery.headers.location, inertia: settingsInertia.headers.location, auth: auth.status, authChild: authChild.status }, [
        ctx.equal("a document visit", [settings.status, settings.headers.location], [302, "/auth?redirect=%2Fsettings"]),
        ctx.equal("the whole URL, query included, is encoded into redirect", [settingsQuery.status, settingsQuery.headers.location], [302, "/auth?redirect=%2Fsettings%3Ftab%3Da%2520b%26x%3D1"]),
        ctx.equal("an Inertia visit", [settingsInertia.status, settingsInertia.headers.location], [302, "/auth?redirect=%2Fsettings"]),
        ctx.equal("the sign-in page itself is served", auth.status, 200),
        ctx.holds("a path below the sign-in path is exempt from the redirect", !(authChild.headers.location ?? "").startsWith("/auth?redirect="), authChild.headers.location ?? authChild.status),
        ctx.equal("signed in, the same page is served", (await exchange(web, { path: "/settings", headers: { ...html, cookie } })).status, 200),
      ]);

      const malformed = await exchange(web, { path: "/projects/%E0%A4%A", headers: { ...html, cookie } });
      observe(ctx, "a path no decoder accepts answers 400", { status: malformed.status, text: malformed.text, type: malformed.headers["content-type"] }, [
        ctx.equal("400 Bad Request in plain text", [malformed.status, malformed.text, malformed.headers["content-type"]], [400, "Bad Request", "text/plain; charset=utf-8"]),
      ]);

      const page = await exchange(web, { path: "/examples/overview", headers: { ...inertia, cookie } });
      const version = page.headers["x-inertia-version"];
      const stale = await exchange(web, { path: "/examples/overview?a=1", headers: { ...inertia, "x-inertia-version": "stale", cookie } });
      const current = await exchange(web, { path: "/examples/overview", headers: { ...inertia, "x-inertia-version": version, cookie } });
      observe(ctx, "an Inertia visit with a stale asset version is told to reload", { version, stale: stale.headers, current: current.status }, [
        ctx.holds("the version is the hash of the client manifest: 64 hex digits", /^[0-9a-f]{64}$/.test(version ?? ""), version),
        ctx.equal("a stale version answers 409 with the location to reload and the current version", [stale.status, stale.headers["x-inertia-location"], stale.headers["x-inertia-version"], stale.headers.vary, stale.body.length], [409, "/examples/overview?a=1", version, "X-Inertia", 0]),
        ctx.equal("the current version is served", current.status, 200),
        ctx.equal("a visit with no version header is served", page.status, 200),
      ]);
    },
  },
  {
    id: "routing-page-props",
    title: "page props: the site layout is a once prop, partial reloads send the props they name, and a build without server modules serves no module route",
    entryPoint: "Inertia visits to the run's frontend as the administrator, and a second `ajs dms start` whose server-modules bundle is missing",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const web = ctx.state.webUrl;
      const cookie = await adminCookie(web, ctx.adminCredentials());
      const visit = (headers = {}) => exchange(web, { path: "/examples/overview", headers: { ...inertia, cookie, ...headers } });
      const full = bodyJson(await visit());
      const onceKeys = keysOf(rowAt(full, "onceProps"));
      const held = bodyJson(await visit({ "x-inertia-except-once-props": onceKeys[0] }));
      const partialHeaders = { "x-inertia-partial-component": "DmsDynamicPage", "x-inertia-except-once-props": onceKeys[0] };
      const partial = bodyJson(await visit({ ...partialHeaders, "x-inertia-partial-data": "page" }));
      const except = bodyJson(await visit({ ...partialHeaders, "x-inertia-partial-data": "user,session,page", "x-inertia-partial-except": "user,session" }));
      const layoutAsked = bodyJson(await visit({ "x-inertia-partial-component": "DmsDynamicPage", "x-inertia-partial-data": "shared" }));
      const wrongComponent = bodyJson(await visit({ "x-inertia-partial-component": "Other", "x-inertia-partial-data": "page" }));
      const first = rowAt(full, "onceProps", onceKeys[0]);
      observe(ctx, "once props and partial reloads", { fullKeys: keysOf(rowAt(full, "props")), onceProps: at(full, "onceProps"), heldKeys: keysOf(rowAt(held, "props")), heldOnce: at(held, "onceProps"), partialKeys: keysOf(rowAt(partial, "props")), exceptKeys: keysOf(rowAt(except, "props")) }, [
        ctx.equal("a full visit carries path, user, session, page, the shared site layout and errors", keysOf(rowAt(full, "props")).sort(), ["errors", "page", "path", "session", "shared", "user"]),
        ctx.holds("the layout is declared once per account and workspace: shared:<16 characters>", onceKeys.length === 1 && /^shared:[A-Za-z0-9_-]{16}$/.test(onceKeys[0]), onceKeys.join(",")),
        ctx.holds("its copy expires in five minutes", first?.prop === "shared" && Math.abs((numberAt(first, "expiresAt") ?? 0) - Date.now() - 300_000) < 30_000, JSON.stringify(first)),
        ctx.equal("a browser that holds the layout is not sent it again, and the declaration never expires", [Object.hasOwn(rowAt(held, "props") ?? {}, "shared"), at(held, "onceProps", onceKeys[0])], [false, { prop: "shared", expiresAt: null }]),
        ctx.equal("a partial reload sends only the props it names", keysOf(rowAt(partial, "props")).sort(), ["errors", "page"]),
        ctx.equal("x-inertia-partial-except leaves props out", keysOf(rowAt(except, "props")).sort(), ["errors", "page"]),
        ctx.equal("a partial reload from a browser that does not hold this session's layout is sent it too", keysOf(rowAt(layoutAsked, "props")).sort(), ["errors", "shared"]),
        ctx.equal("a partial reload of another component is a full visit", keysOf(rowAt(wrongComponent, "props")).sort(), ["errors", "page", "path", "session", "shared", "user"]),
      ]);
      await withSatellite(ctx, { remove: ["dist/server-modules"] }, async (server) => {
        const lines = server.log().split("\n");
        const route = await exchange(server.url, { path: "/docs-fixtures/helio" });
        const api = await exchange(server.url, { path: "/api/onboarding/informations" });
        observe(ctx, "a build without the server-modules bundle", { lines: lines.filter((line) => line.startsWith("Routing:") || line.includes("backend proxy")), route: route.status, api: api.status }, [
          ctx.equal("the report counts no module route and no proxy", [lines.find((line) => line.startsWith("Routing:")), lines.includes("  (no backend proxy declared: no request reaches the backend)")], ["Routing: renderer files, then 0 module routes, then the backend proxies below, then the pages", true]),
          ctx.holds("a module route is not served: the path is a page", route.headers["content-type"] !== "application/json" || route.status !== 404 || !route.text.includes("No docs fixture"), route.text.slice(0, 80)),
          ctx.holds("an /api path is not proxied: the answer is not the backend's JSON", !/application\/json/.test(String(api.headers["content-type"] ?? "")), String(api.headers["content-type"])),
        ]);
      });
    },
  },
  {
    id: "routing-listen",
    title: "start listens on every interface; HOST narrows it; a taken port stops the server with a message",
    entryPoint: "`ajs dms start` with and without HOST, and on a port another process holds",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const address = externalAddress();
      await withSatellite(ctx, {}, async (server) => {
        const reached = address ? await exchange(`http://${address}:${server.port}`, { path: "/dms-preview" }).then((answer) => answer.status, () => null) : "no external address";
        observe(ctx, "default: every interface", { address, reached }, [
          ctx.holds("this machine has an external IPv4 address to test with", Boolean(address), address),
          ctx.equal("the server answers on it", reached, 200),
          ctx.holds("the ready block lists a Network URL", /Network:\s+http:\/\/\d+\.\d+\.\d+\.\d+:\d+\//.test(server.log()), server.log().split("\n").find((line) => line.includes("Network:")) ?? "none"),
        ]);
      });
      await withSatellite(ctx, { env: { HOST: "127.0.0.1" } }, async (server) => {
        const loopback = await exchange(server.url, { path: "/dms-preview" }).then((answer) => answer.status, () => null);
        const external = address ? await exchange(`http://${address}:${server.port}`, { path: "/dms-preview", timeoutMs: 3000 }).then((answer) => answer.status, (/** @type {unknown} */ error) => textAt(error, "code") ?? String(error)) : "no address";
        observe(ctx, "HOST=127.0.0.1", { loopback, external }, [
          ctx.equal("the loopback address answers", loopback, 200),
          ctx.holds("the external address refuses the connection", external === "ECONNREFUSED", external),
          ctx.holds("the ready block lists no Network URL", !server.log().includes("Network:"), server.log().split("\n").find((line) => line.includes("Network:")) ?? "none"),
        ]);
      });
      const taken = await freePort();
      const holder = createServer();
      await new Promise((resolve) => holder.listen(taken, "0.0.0.0", resolve));
      try {
        const server = await startSatellite(ctx, { port: taken, expectExit: true });
        const code = await Promise.race([server.exited, sleep(30_000).then(() => "still running")]);
        const log = server.log();
        await server.stop();
        observe(ctx, "a port another process holds", { code, log }, [
          ctx.holds("the server stops with a failure instead of moving on", code === 1, code),
          ctx.holds("the output names the port and the cause", log.includes(`cannot listen on 0.0.0.0:${taken}`) || log.includes(String(taken)), log.slice(-400)),
        ]);
      } finally {
        holder.close();
      }
    },
  },
];
