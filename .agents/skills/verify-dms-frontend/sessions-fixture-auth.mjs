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
export const modules = [
  {
    id: "auth/bad",
    priority: 60,
    setup(/** @type {Server} */ server) {
      server.registerAuth({ signInPath: "/a/*" });
      server.registerAuth({ signInExempt: ["bad"] });
      server.registerAuth({ signInExempt: ["/share/*/view"] });
      server.registerAuth({ refreshSession: "no" });
      server.registerAuth("text");
    },
  },
  {
    id: "auth/high",
    priority: 50,
    setup(/** @type {Server} */ server) {
      server.registerAuth({
        signInPath: "/login",
        async refreshSession(/** @type {Event} */ event, /** @type {Session} */ session) {
          const next = { ...session, accessToken: "fresh" };
          event.session.write(next);
          return next;
        },
        publicSession: (/** @type {Session} */ session) => ({ user: { name: session.user.name }, session: { accountId: session.accountId } }),
      });
      server.registerRoute("POST", "/login-test", (/** @type {Event} */ event) => {
        event.session.write({ accessToken: "stale", refreshToken: "r", user: { name: "Hooked" }, accountId: "acc-1", activeTenantId: "t1" });
        return { written: true };
      }, { sameOrigin: false });
      server.registerRoute("GET", "/api/_hook/view", (/** @type {Event} */ event) => event.session.view());
      server.registerRoute("GET", "/api/_hook/token", (/** @type {Event} */ event) => ({ token: event.session.read()?.accessToken ?? null }));
    },
  },
  {
    id: "auth/low",
    priority: 1,
    setup(/** @type {Server} */ server) {
      server.registerAuth({ signInPath: "/other" });
    },
  },
];
