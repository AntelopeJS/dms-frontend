import { isText } from "./json.mjs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { accessToken, FAKE_USER, setCookies } from "./proxy-signin.mjs";

const FORBIDDEN = { error: "Forbidden" };
const CROSS_ORIGIN = { error: "Forbidden", reason: "missing or untrusted Origin header" };
const ENVIRONMENT = ["/api/saas/register/finalize", "/api/two/fa", " /api/tenant/assign ", "/api/saas/denied", "bad", "/api/x?y=1", "/api/../etc", "/other/api/x", "/api/saas/register/finalize"].join(",");

export const journeys = [
  {
    id: "sessions-establish",
    title: "POST /auth/establish opens a session only from a declared backend endpoint, and the browser never carries a token",
    entryPoint: "POST /auth/establish on the run's frontend and on a second `ajs dms start` with declared and operator endpoints",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const web = ctx.state.webUrl;
      const post = (/** @type {string} */ url, /** @type {unknown} */ body, /** @type {Record<string, string>} */ headers = { origin: url }) => exchange(url, { method: "POST", path: "/auth/establish", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const outcome = (/** @type {import("./proxy-http.mjs").Exchange} */ answer) => [answer.status, bodyJson(answer)];
      const declared = await post(web, { endpoint: "/api/auth/session-handoff", payload: {} });
      /** @type {Record<string, unknown[]>} */
      const refusals = {};
      for (const [label, endpoint] of [
        ["an undeclared endpoint", "/api/auth/login"],
        ["a query string", "/api/auth/session-handoff?x=1"],
        ["a trailing slash", "/api/auth/session-handoff/"],
        ["a path below it", "/api/auth/session-handoff/extra"],
        ["a traversal", "/api/auth/../auth/session-handoff"],
        ["a prefix of it", "/api/auth"],
        ["another case", "/API/auth/session-handoff"],
        ["an absolute URL", "https://evil.example/api/auth/session-handoff"],
        ["a protocol-relative URL", "//evil.example/api/auth/session-handoff"],
        ["a number", 42],
        ["nothing", undefined],
      ]) refusals[label] = outcome(await post(web, { endpoint, payload: {} }));
      const get = await exchange(web, { path: "/auth/establish" });
      const noOrigin = await exchange(web, { method: "POST", path: "/auth/establish", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: "/api/auth/session-handoff" }) });
      const wrongOrigin = await post(web, { endpoint: "/api/auth/session-handoff" }, { origin: "https://evil.example" });
      observe(ctx, "the run's declared endpoint, and every way around the allow-list", { declared: outcome(declared), refusals, get: [get.status, get.headers.allow] }, [
        ctx.holds("the declared endpoint is called: the answer is the backend's, not the allow-list's refusal", JSON.stringify(bodyJson(declared)) !== JSON.stringify(FORBIDDEN), declared.text.slice(0, 200)),
        ctx.equal("every other spelling answers 403 {error: Forbidden} and is never called", Object.values(refusals), Object.keys(refusals).map(() => [403, FORBIDDEN])),
        ctx.equal("GET is a 405 naming POST", [get.status, get.headers.allow], [405, "POST"]),
        ctx.equal("a POST without or with another site's Origin is refused", [noOrigin, wrongOrigin].map(outcome), [[403, CROSS_ORIGIN], [403, CROSS_ORIGIN]]),
      ]);

      const pair = { access_token: accessToken("tenant-9"), refresh_token: "refresh-est", user: FAKE_USER };
      const backend = (/** @type {import("node:http").IncomingMessage} */ request, /** @type {import("node:http").ServerResponse} */ response) => {
        request.resume();
        request.on("end", () => {
          const send = (/** @type {number} */ status, /** @type {unknown} */ body) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(isText(body) ? body : JSON.stringify(body));
          };
          switch (request.url) {
            case "/api/saas/register/finalize":
            case "/api/saas/declared":
              return send(200, pair);
            case "/api/two/fa":
              return send(200, { requires_2fa: true, two_factor_token: "tt-1" });
            case "/api/tenant/assign":
              return send(200, { requires_tenant_assignment: true });
            case "/api/saas/denied":
              return send(403, "error.saas.denied");
            case "/api/auth/me":
              return send(200, FAKE_USER);
            default:
              return send(200, {});
          }
        });
      };
      await withSatellite(ctx, {
        backend,
        env: { DMS_AUTH_ESTABLISH_ENDPOINTS: ENVIRONMENT, DMS_COOKIE_SECURE: "false" },
        files: { "generated-auth-establish.json": JSON.stringify({ endpoints: ["/api/saas/declared", "not-valid", "/api/x?y=2"] }) },
      }, async (server) => {
        const send = (/** @type {unknown} */ endpoint, /** @type {unknown} */ payload) => post(server.url, payload === undefined ? { endpoint } : { endpoint, payload });
        const fromEnvironment = await send("/api/saas/register/finalize", { code: "abc" });
        const fromManifest = await send("/api/saas/declared");
        const twoFactor = await send("/api/two/fa", { a: 1 });
        const tenant = await send("/api/tenant/assign", {});
        const denied = await send("/api/saas/denied", {});
        /** @type {Record<string, number>} */
        const dropped = {};
        for (const endpoint of ["bad", "/api/x?y=1", "/api/x?y=2", "/api/../etc", "/other/api/x", "not-valid"]) dropped[endpoint] = (await send(endpoint, {})).status;
        const finalizeCalls = server.backend.to("/api/saas/register/finalize");
        const declaredCalls = server.backend.to("/api/saas/declared");
        observe(ctx, "declared endpoints are the union of the manifest's and the environment's", { fromEnvironment: outcome(fromEnvironment), fromManifest: outcome(fromManifest), twoFactor: outcome(twoFactor), tenant: outcome(tenant), denied: outcome(denied), dropped, cookies: setCookies(fromEnvironment).map((line) => line.replace(/=[^;]*/, "=VALUE")) }, [
          ctx.equal("an endpoint from DMS_AUTH_ESTABLISH_ENDPOINTS opens a session: the body is the user and the account", [fromEnvironment.status, Object.keys(bodyJson(fromEnvironment)).sort(), bodyJson(fromEnvironment).user.email], [200, ["account", "user"], FAKE_USER.email]),
          ctx.equal("the browser gets no token", /access_token|refresh_token|accessToken|eyJ/.test(fromEnvironment.text), false),
          ctx.holds("the session cookie is set", setCookies(fromEnvironment).some((line) => line.startsWith("dms_session_")), setCookies(fromEnvironment).length),
          ctx.equal("the payload is forwarded to the backend as the body", [finalizeCalls.length, JSON.parse(finalizeCalls[0].body.toString())], [1, { code: "abc" }]),
          ctx.equal("an endpoint from the generated manifest file works too, with an empty payload by default", [fromManifest.status, JSON.parse(declaredCalls[0].body.toString())], [200, {}]),
          ctx.equal("a second step is relayed as the backend answered it, without a session", [outcome(twoFactor), setCookies(twoFactor).some((line) => line.startsWith("dms_session_"))], [[200, { requires_2fa: true, two_factor_token: "tt-1" }], false]),
          ctx.equal("the pending login is a sealed cookie scoped to /auth/verify-2fa for 5 minutes", setCookies(twoFactor).filter((line) => line.startsWith("dms_pending_login_")).map((line) => line.replace(/=[^;]*/, "=VALUE").replace(/_[0-9a-f]{12}=/, "_SCOPE=")), ["dms_pending_login_SCOPE=VALUE; Path=/auth/verify-2fa; HttpOnly; SameSite=Lax; Max-Age=300"]),
          ctx.equal("a tenant assignment is relayed without a session", [outcome(tenant), setCookies(tenant).some((line) => line.startsWith("dms_session_"))], [[200, { requires_tenant_assignment: true }], false]),
          ctx.equal("a backend refusal keeps its status and public message", outcome(denied), [403, { message: "error.saas.denied" }]),
          ctx.equal("malformed environment and manifest entries are dropped, not widened", dropped, { bad: 403, "/api/x?y=1": 403, "/api/x?y=2": 403, "/api/../etc": 403, "/other/api/x": 403, "not-valid": 403 }),
          ctx.equal("the duplicate environment entry is one endpoint: called once per request", finalizeCalls.length, 1),
        ]);
      });
    },
  },
];
