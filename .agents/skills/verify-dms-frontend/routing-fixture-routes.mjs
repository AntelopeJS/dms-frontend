/**
 * @typedef {object} Session
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {{ name: string }} [user]
 * @property {string} [accountId]
 * @property {string} [activeTenantId]
 */
/**
 * @typedef {object} Event
 * @property {Request} request
 * @property {Record<string, string>} params
 * @property {() => Promise<unknown>} readJson
 * @property {{ id: string, options: unknown, privateOptions: unknown }} module
 * @property {{ authEstablishEndpoints: readonly string[] }} app
 * @property {() => string} clientIp
 * @property {(path: string, init?: { method?: string }) => Promise<unknown>} backend
 * @property {(path: string) => string} backendUrl
 * @property {{ read(): Session | undefined, view(): unknown, write(session: Session): void }} session
 * @property {{ readSealed(name: string, accepts: (value: unknown) => boolean): unknown, writeSealed(name: string, value: unknown, options?: { maxAge?: number, path?: string }): void, clear(name: string, options?: { path?: string }): void }} cookies
 */
/**
 * @typedef {object} Server
 * @property {(method: string | string[], path: string, handler: unknown, options?: unknown) => void} registerRoute
 * @property {(rules: unknown) => void} registerRouteRules
 * @property {(auth: unknown) => void} registerAuth
 */
const OVERLAP = "/api/_acme/o";

export const modules = [
  {
    id: "@acme/shop",
    priority: 10,
    setup(/** @type {Server} */ server) {
      server.registerRoute("GET", "/api/_acme/ping", () => ({ ok: true }));
      server.registerRoute("GET", "/api/_acme/items/new", () => ({ item: "new" }));
      server.registerRoute("GET", "/api/_acme/items/:id", (/** @type {Event} */ event) => ({ id: event.params.id }));
      server.registerRoute("GET", "/api/_acme/pair/:a/:b", (/** @type {Event} */ event) => ({ ...event.params }));
      server.registerRoute("POST", "/api/_acme/echo", async (/** @type {Event} */ event) => ({ received: await event.readJson() }));
      server.registerRoute("POST", "/api/_acme/small", async (/** @type {Event} */ event) => ({ bytes: (await event.request.arrayBuffer()).byteLength }), { bodyLimit: 10 });
      server.registerRoute("POST", "/api/_acme/size", async (/** @type {Event} */ event) => ({ bytes: (await event.request.arrayBuffer()).byteLength }));
      server.registerRoute("POST", "/api/_acme/open", () => ({ open: true }), { sameOrigin: false });
      server.registerRoute("GET", "/api/_acme/nothing", () => undefined);
      server.registerRoute("GET", "/api/_acme/null", () => null);
      server.registerRoute("GET", "/api/_acme/response", () => new Response("created", { status: 201, headers: { "cache-control": "max-age=5", "x-own": "1", "content-type": "text/plain" } }));
      server.registerRoute("GET", "/api/_acme/default-cache", () => new Response("plain"));
      server.registerRoute("GET", "/api/_acme/throws", () => {
        throw Object.assign(new Error("secret internal detail"), { status: 409 });
      });
      server.registerRoute("GET", "/api/_acme/throws-plain", () => {
        throw new Error("boom");
      });
      server.registerRoute("GET", "/api/_acme/denied", (/** @type {Event} */ event) => event.backend("/api/acme/denied"));
      server.registerRoute("GET", "/api/_acme/broken", (/** @type {Event} */ event) => event.backend("/api/acme/broken"));
      server.registerRoute("GET", "/api/_acme/redirected", (/** @type {Event} */ event) => event.backend("/api/acme/redirect"));
      server.registerRoute("GET", "/api/_acme/data", (/** @type {Event} */ event) => event.backend("/api/acme/data"));
      server.registerRoute("GET", "/api/_acme/relay", (/** @type {Event} */ event) => fetch(event.backendUrl("/api/acme/relay"), { redirect: "manual" }));
      server.registerRoute("GET", "/api/_acme/relay-out", (/** @type {Event} */ event) => fetch(event.backendUrl("/api/acme/relay-out"), { redirect: "manual" }));
      server.registerRoute("GET", "/api/_acme/follow", (/** @type {Event} */ event) => fetch(event.backendUrl("/api/acme/follow")));
      server.registerRoute(["PUT", "DELETE"], "/api/_acme/multi", (/** @type {Event} */ event) => ({ method: event.request.method }));
      server.registerRoute("GET", "/acme-page", () => ({ page: "module" }));
      server.registerRoute("GET", "/api/_acme/who", (/** @type {Event} */ event) => ({ module: event.module, endpoints: event.app.authEstablishEndpoints, isFrozen: Object.isFrozen(event.module), ip: event.clientIp() }));
      server.registerRoute("POST", "/api/_acme/cookie", (/** @type {Event} */ event) => {
        event.cookies.writeSealed("prefs", { theme: "dark" }, { maxAge: 60, path: "/x" });
        return { written: true };
      });
      server.registerRoute("GET", "/api/_acme/cookie", (/** @type {Event} */ event) => ({
        prefs: event.cookies.readSealed("prefs", (value) => value?.theme === "dark") ?? null,
        rejected: event.cookies.readSealed("prefs", () => false) ?? null,
      }));
      server.registerRoute("DELETE", "/api/_acme/cookie", (/** @type {Event} */ event) => {
        event.cookies.clear("prefs", { path: "/x" });
        return {};
      });
      server.registerRoute("GET", "/api/_acme/dms-cookie", (/** @type {Event} */ event) => {
        event.cookies.writeSealed("dms_flag", { a: 1 });
        return {};
      });
      server.registerRoute("GET", "/api/_acme/session-cookie", (/** @type {Event} */ event) => {
        event.cookies.writeSealed("dms_session", {});
        return {};
      });
      server.registerRoute("GET", "/api/_acme/bad-cookie-name", (/** @type {Event} */ event) => {
        event.cookies.writeSealed("bad name", {});
        return {};
      });
      server.registerRoute("GET", "/api/users", () => ({ shadow: true }));
      server.registerRoute("GET", "/api/override", () => ({ override: true }), { overridesBackend: true });
      server.registerRoute("GET", "/dms/thing", () => ({ shadow: true }));
      server.registerRoute("POST", "/api/acme/events/:a/:b", () => ({ module: true }), { overridesBackend: true, sameOrigin: false });
      server.registerRoute("GET", `${OVERLAP}/:x`, () => ({ owner: "acme-param" }));
      server.registerRoute("GET", "/api/_acme/tie", () => ({ owner: "acme" }));
      server.registerRoute("GET", "/:anything", () => ({ owner: "root-param" }));
      server.registerRoute("GET", "/assets/mine", () => ({ mine: true }));
      server.registerRoute("GET", "/api/_dms/mine", () => ({ mine: true }));
      server.registerRoute("GET", "/@mine", () => ({ mine: true }));
      server.registerRoute("GET", "/node_modules/mine", () => ({ mine: true }));
      server.registerRoute("FETCH", "/api/_acme/bad-method", () => ({}));
      server.registerRoute("GET", "api/_acme/no-slash", () => ({}));
      server.registerRoute("GET", "/api/_acme/with space", () => ({}));
      server.registerRoute("GET", "/api/_acme/../escape", () => ({}));
      server.registerRoute("GET", "/api/_acme/dup/:x/:x", () => ({}));
      server.registerRoute("GET", "/api/_acme/no-handler", "not a function");
      server.registerRoute("GET", "/api/_acme/bad-limit", () => ({}), { bodyLimit: -1 });
      server.registerRoute("GET", "/api/_acme/bad-origin", () => ({}), { sameOrigin: "yes" });
      server.registerRoute("GET", "/api/_acme/bad-options", () => ({}), "options");
    },
  },
  {
    id: "zeta/other",
    priority: 5,
    setup(/** @type {Server} */ server) {
      server.registerRoute("GET", "/api/_acme/ping", () => ({ owner: "zeta" }));
      server.registerRoute("GET", `${OVERLAP}/fixed`, () => ({ owner: "zeta-fixed" }));
      server.registerRoute("POST", "/api/_zeta/cookie", (/** @type {Event} */ event) => {
        event.cookies.writeSealed("prefs", { theme: "light" });
        return {};
      });
      server.registerRoute("GET", "/api/_zeta/cookie", (/** @type {Event} */ event) => ({ prefs: event.cookies.readSealed("prefs", () => true) ?? null }));
    },
  },
  {
    id: "@acme/my_shop-x.y",
    priority: 3,
    setup(/** @type {Server} */ server) {
      server.registerRoute("POST", "/api/_myshop/cookie", (/** @type {Event} */ event) => {
        event.cookies.writeSealed("prefs", { theme: "light" });
        return {};
      });
    },
  },
  {
    id: "beta/same",
    priority: 10,
    setup(/** @type {Server} */ server) {
      server.registerRoute("GET", "/api/_acme/tie", () => ({ owner: "beta" }));
    },
  },
  {
    id: "bad/setup",
    priority: 1,
    setup() {
      throw new Error("boom in setup");
    },
  },
];
