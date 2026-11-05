import { readFileSync } from "node:fs";
import { at, isNumber, numberAt, rowAt, textAt } from "./json.mjs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { cookieHeader, fakeAuthBackend, setCookies, signIn } from "./proxy-signin.mjs";

const source = (name) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const inertia = { "x-inertia": "true" };

/**
 * @param {() => string} wanted The bearer token the backend accepts
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void} fallback Other routes
 * @returns {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => void} The page backend
 */
function pageBackend(wanted, fallback) {
  return (request, response) => {
    const url = new URL(request.url, "http://backend.local");
    request.resume();
    if (url.pathname === "/dms/page" || url.pathname === "/dms/sitelayout") {
      if (wanted() && request.headers.authorization !== `Bearer ${wanted()}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"message":"error.unauthorized"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      const path = url.searchParams.get("path");
      response.end(JSON.stringify(url.pathname === "/dms/page" ? { componentName: path, route: { fullSlug: path, hasAccess: true }, layout: { layout: { componentName: "DefaultLayout" } } } : {}));
      return;
    }
    fallback(request, response);
  };
}

const redirectTo = (/** @type {string} */ path) => `/auth?redirect=${encodeURIComponent(path)}`;

export const journeys = [
  {
    id: "sessions-hooks",
    title: "auth hooks: a refused session is renewed once and the visit retried, a signed-out visit goes to sign-in, the highest-priority module provides every hook",
    entryPoint: "Inertia visits with and without a session to a second `ajs dms start` whose backend refuses stale tokens",
    onboard: false,
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      /** @type {import("./proxy-signin.mjs").FakeAuth} */
      let auth = { refreshes: [], version: 1, current: "", logins: 0, refuse: false };
      const fake = fakeAuthBackend(pageBackend(() => auth.current, (request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }), { refreshDelayMs: 400 });
      auth = fake.auth;
      await withSatellite(ctx, { backend: fake.handler, env: { DMS_COOKIE_SECURE: "false" } }, async (server) => {
        const visit = (/** @type {string} */ path, /** @type {Record<string, string>} */ headers = {}) => exchange(server.url, { path, headers: { ...inertia, ...headers } });
        const first = await signIn(server);
        const staleToken = auth.current;
        auth.current = `${staleToken}-rotated`;
        const renewed = await visit("/private", { cookie: first.cookie });
        const page = bodyJson(renewed);
        const calls = server.backend.to("/dms/page").map((seen) => seen.headers.authorization);
        const renewedCookies = setCookies(renewed);
        observe(ctx, "a visit the backend refuses is renewed once and retried", { status: renewed.status, props: at(page, "props"), calls, refreshes: auth.refreshes, cookies: renewedCookies.length }, [
          ctx.equal("the visit is served", renewed.status, 200),
          ctx.equal("the renewal asked the backend once, with the refresh token", auth.refreshes, ["refresh-login-1"]),
          ctx.equal("the backend saw the stale token, then the renewed one", [calls[0], calls[1] === `Bearer ${auth.current}`], [`Bearer ${staleToken}`, true]),
          ctx.equal("the page props carry the renewed tenant and a write time", [textAt(page, "props", "session", "activeTenantId"), isNumber(at(page, "props", "session", "updatedAt")), textAt(page, "props", "user", "email")], ["tenant-2", true, "fake@verify.local"]),
          ctx.holds("the renewed session is written to the browser", renewedCookies.some((line) => line.startsWith("dms_session_")), renewedCookies.length),
        ]);

        const second = await signIn(server);
        auth.current = `${auth.current}-again`;
        const before = auth.refreshes.length;
        const burst = await Promise.all(Array.from({ length: 5 }, () => visit("/private", { cookie: second.cookie })));
        observe(ctx, "requests that need the renewal at the same time share one", { statuses: burst.map((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => answer.status), refreshes: auth.refreshes.slice(before) }, [
          ctx.equal("every visit is served", burst.map((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => answer.status), [200, 200, 200, 200, 200]),
          ctx.equal("the backend was asked to renew once", auth.refreshes.slice(before), ["refresh-login-2"]),
        ]);

        const third = await signIn(server);
        auth.current = `${auth.current}-refused`;
        auth.refuse = true;
        const refused = await visit("/private?a=1", { cookie: third.cookie });
        const clearing = setCookies(refused).find((line) => line.startsWith("dms_session_"));
        auth.refuse = false;
        observe(ctx, "a refused renewal signs the browser out", { status: refused.status, location: refused.headers.location, clearing }, [
          ctx.equal("the visit goes to sign-in with the page to return to", [refused.status, refused.headers.location], [302, redirectTo("/private?a=1")]),
          ctx.holds("the session cookie is expired", /^dms_session_[0-9a-f]{12}=; .*Max-Age=0/.test(clearing ?? ""), clearing),
        ]);

        const anonymous = {
          private: await visit("/private?a=1"),
          authors: await visit("/authors"),
          authRoot: await visit("/auth"),
          authChild: await visit("/auth/callback"),
          onboarding: await visit("/onboarding"),
        };
        const statusOf = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.headers.location ?? null, answer.status === 401 ? at(bodyJson(answer), "props", "error") : null];
        observe(ctx, "a signed-out visit to a page the backend refuses", Object.fromEntries(Object.entries(anonymous).map(([name, answer]) => [name, statusOf(answer)])), [
          ctx.equal("a private page goes to /auth with ?redirect=", statusOf(anonymous.private).slice(0, 2), [302, redirectTo("/private?a=1")]),
          ctx.equal("/authors is not below /auth: it goes to sign-in too", statusOf(anonymous.authors).slice(0, 2), [302, redirectTo("/authors")]),
          ctx.equal("/auth, /auth/callback and /onboarding are exempt: the refusal is shown", [anonymous.authRoot, anonymous.authChild, anonymous.onboarding].map(statusOf), [[401, null, { statusCode: 401 }], [401, null, { statusCode: 401 }], [401, null, { statusCode: 401 }]]),
        ]);
      });

      const hooked = pageBackend(() => "fresh", (request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
      await withSatellite(ctx, { backend: hooked, modules: { source: source("sessions-fixture-auth.mjs"), keepOriginal: true }, env: { DMS_COOKIE_SECURE: "false" } }, async (server) => {
        const lines = server.log().split("\n");
        const ignored = (id, reason) => `Frontend module ${id} registers auth hooks, which are ignored: ${reason}.`;
        const expected = [
          ignored("auth/bad", "signInPath is not a page path"),
          ignored("auth/bad", "signInExempt is not a list of /x, /x/* or /x/** patterns"),
          ignored("auth/bad", "refreshSession is not a function"),
          ignored("auth/bad", "it is not an object"),
          ignored("auth/low", "auth/high (priority 50) provides them"),
          ignored("antelopejs__dms-frontend-vue", "auth/high (priority 50) provides them"),
        ];
        observe(ctx, "only the highest-priority module that registers valid hooks provides them", { warnings: lines.filter((line) => line.includes("registers auth hooks")) }, [
          ctx.equal("each ignored registration is reported once with its reason", expected.map((text) => lines.filter((line) => line === text).length), expected.map(() => 1)),
        ]);
        const login = await exchange(server.url, { method: "POST", path: "/login-test" });
        const cookie = cookieHeader(setCookies(login));
        const view = bodyJson(await exchange(server.url, { path: "/api/_hook/view", headers: { cookie } }));
        const visit = await exchange(server.url, { path: "/private", headers: { ...inertia, cookie } });
        const props = rowAt(bodyJson(visit), "props") ?? {};
        const token = bodyJson(await exchange(server.url, { path: "/api/_hook/token", headers: { cookie } }));
        const seen = server.backend.to("/dms/page").map((entry) => entry.headers.authorization);
        const outcomes = {
          private: await exchange(server.url, { path: "/private?x=1", headers: inertia }),
          oldPath: await exchange(server.url, { path: "/auth", headers: inertia }),
          child: await exchange(server.url, { path: "/login/step", headers: inertia }),
          onboarding: await exchange(server.url, { path: "/onboarding", headers: inertia }),
        };
        observe(ctx, "the provider's publicSession, refreshSession and signInPath", { view, props, seen, outcomes: Object.fromEntries(Object.entries(outcomes).map(([name, answer]) => [name, [answer.status, answer.headers.location]])) }, [
          ctx.equal("publicSession builds the props, and the server adds updatedAt", [view.user, view.session.accountId, isNumber(view.session.updatedAt)], [{ name: "Hooked" }, "acc-1", true]),
          ctx.equal("the visit with the refused token is retried with the session the hook wrote", seen, ["Bearer stale", "Bearer fresh"]),
          ctx.equal("the retried page shows the hook's view with a newer updatedAt", [props.user, textAt(props, "session", "accountId"), (numberAt(props, "session", "updatedAt") ?? 0) >= (numberAt(view, "session", "updatedAt") ?? Infinity)], [{ name: "Hooked" }, "acc-1", true]),
          ctx.equal("a module route can read the session's token, which the browser never gets", [token, JSON.stringify(view).includes("stale")], [{ token: "stale" }, false]),
          ctx.equal("signInPath /login is where a signed-out visit goes", [outcomes.private.status, outcomes.private.headers.location], [302, `/login?redirect=${encodeURIComponent("/private?x=1")}`]),
          ctx.equal("the default exemptions follow the custom signInPath: /login/** and /onboarding", [outcomes.child.status, outcomes.onboarding.status], [401, 401]),
          ctx.equal("the old default /auth is no longer exempt", [outcomes.oldPath.status, outcomes.oldPath.headers.location], [302, `/login?redirect=${encodeURIComponent("/auth")}`]),
        ]);
      });

      await withSatellite(ctx, { backend: pageBackend(() => "never", (request, response) => response.end("{}")), modules: { source: source("sessions-fixture-exempt.mjs") } }, async (server) => {
        const visit = (/** @type {string} */ path) => exchange(server.url, { path, headers: inertia }).then((/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, answer.headers.location ?? null]);
        const redirect = (/** @type {string} */ path) => [302, redirectTo(path)];
        observe(ctx, "signInExempt patterns: /x, /x/* and /x/**, whole segments", {}, [
          ctx.equal("/open is exempt, /open/x is not", [await visit("/open"), await visit("/open/x")], [[401, null], redirect("/open/x")]),
          ctx.equal("/one/* exempts one segment below, not /one and not two below", [await visit("/one/a"), await visit("/one"), await visit("/one/a/b")], [[401, null], redirect("/one"), redirect("/one/a/b")]),
          ctx.equal("/deep/** exempts the page and everything below", [await visit("/deep"), await visit("/deep/a/b")], [[401, null], [401, null]]),
          ctx.equal("a listed set replaces the defaults: /auth and /onboarding are no longer exempt", [await visit("/auth"), await visit("/onboarding")], [redirect("/auth"), redirect("/onboarding")]),
        ]);
      });

      await withSatellite(ctx, { backend: pageBackend(() => "", (request, response) => response.end("{}")), modules: { source: source("sessions-fixture-bare.mjs") } }, async (server) => {
        const anonymous = await exchange(server.url, { path: "/some-page", headers: { ...inertia, cookie: "dms_session_x=y" } });
        const props = rowAt(bodyJson(anonymous), "props") ?? {};
        observe(ctx, "without a module that registers auth hooks", { props: Object.keys(props) }, [
          ctx.equal("pages carry no user and no session", [Object.hasOwn(props, "user"), Object.hasOwn(props, "session")], [false, false]),
          ctx.equal("the page is served", anonymous.status, 200),
        ]);
      });
    },
  },
];
