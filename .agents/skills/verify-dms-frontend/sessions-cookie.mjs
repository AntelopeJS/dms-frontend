import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { at, isNumber, keysOf, numberAt, rowAt, textAt } from "./json.mjs";
import { bodyJson, exchange } from "./proxy-http.mjs";
import { observe, withSatellite } from "./proxy-satellite.mjs";
import { cookieHeader, fakeAuthBackend, setCookies, signIn } from "./proxy-signin.mjs";

const CROSS_ORIGIN = { error: "Forbidden", reason: "missing or untrusted Origin header" };
const MONTH = 2592000;

/**
 * @param {string} url The canonical backend URL
 * @returns {string} The suffix the frontend gives its cookies
 */
function scopeOf(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 12);
}

/**
 * @param {string[]} cookies Set-Cookie lines
 * @param {string} prefix The start of a cookie name
 * @returns {string | undefined} The first line of that cookie
 */
function lineOf(cookies, prefix) {
  return cookies.find((line) => line.startsWith(prefix));
}

/**
 * @param {string | undefined} line A Set-Cookie line
 * @returns {string} The line with its value replaced by VALUE
 */
function withoutValue(line) {
  return (line ?? "").replace(/^([^=]+)=[^;]*/, "$1=VALUE");
}

export const journeys = [
  {
    id: "sessions-cookie",
    title: "the session is a sealed HttpOnly SameSite=Lax cookie scoped to the backend, Secure under start, and the browser never sees a token",
    entryPoint: "POST /auth/login and /api/_auth/session on the run's frontend and on a second `ajs dms start`, and the signed-in dashboard in a browser",
    async run(/** @type {import("./control.d.ts").JourneyContext} */ ctx) {
      const web = ctx.state.webUrl;
      const credentials = ctx.adminCredentials();
      const scope = scopeOf(ctx.state.apiUrl);
      const login = async (/** @type {boolean} */ keepLogin) => {
        const answer = await exchange(web, { method: "POST", path: "/auth/login", headers: { origin: web, "content-type": "application/json" }, body: JSON.stringify({ email: credentials.email, password: credentials.password, keep_login: keepLogin }) });
        return { answer, cookies: setCookies(answer), body: bodyJson(answer) };
      };
      const kept = await login(true);
      const session = await login(false);
      const sessionLine = (/** @type {{ cookies: string[] }} */ entry) => lineOf(entry.cookies, `dms_session_${scope}=`);
      const indexLine = (/** @type {{ cookies: string[] }} */ entry) => lineOf(entry.cookies, `dms_account_index_${scope}=`);
      const accountLine = (/** @type {{ cookies: string[] }} */ entry) => entry.cookies.find((line) => new RegExp(`^dms_account_[0-9a-f]{32}_${scope}=`).test(line));
      const tokenWords = /access_token|refresh_token|accessToken|refreshToken|"token"/;
      observe(ctx, "POST /auth/login sets the session as sealed cookies", { kept: kept.cookies.map(withoutValue), session: session.cookies.map(withoutValue), keys: keysOf(kept.body) }, [
        ctx.equal("keep_login: the session cookie is named dms_session_<12 hex of the backend URL's hash> and lasts 30 days", withoutValue(sessionLine(kept)), `dms_session_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MONTH}; Secure`),
        ctx.equal("keep_login: the account cookies last as long", [withoutValue(indexLine(kept)), withoutValue(accountLine(kept)).replace(/dms_account_[0-9a-f]{32}/, "dms_account_ID")], [`dms_account_index_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MONTH}; Secure`, `dms_account_ID_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MONTH}; Secure`]),
        ctx.equal("without keep_login the cookie ends with the browser: no Max-Age", withoutValue(sessionLine(session)), `dms_session_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Secure`),
        ctx.equal("without keep_login the account cookies end with the browser too", [withoutValue(indexLine(session)), withoutValue(accountLine(session)).replace(/dms_account_[0-9a-f]{32}/, "dms_account_ID")], [`dms_account_index_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Secure`, `dms_account_ID_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Secure`]),
        ctx.equal("the answer holds the user and the account, no token", [keysOf(kept.body).sort(), tokenWords.test(kept.answer.text)], [["account", "user"], false]),
        ctx.equal("the cookie value does not contain the session's data", tokenWords.test(Buffer.from(/^[^=]+=([^;]*)/.exec(sessionLine(kept))[1], "base64url").toString("latin1")) || /eyJ/.test(sessionLine(kept)), false),
      ]);

      const cookie = cookieHeader(kept.cookies);
      const sessionValue = /^[^=]+=([^;]*)/.exec(sessionLine(kept))[1];
      const view = (/** @type {Record<string, string>} */ headers) => exchange(web, { path: "/api/_auth/session", headers });
      const valid = await view({ cookie });
      const tampered = await view({ cookie: `dms_session_${scope}=${sessionValue.slice(0, -2)}${sessionValue.endsWith("AA") ? "BB" : "AA"}` });
      const truncated = await view({ cookie: `dms_session_${scope}=${sessionValue.slice(0, 20)}` });
      const garbage = await view({ cookie: `dms_session_${scope}=not-a-session` });
      const otherScope = await view({ cookie: `dms_session_${"0".repeat(12)}=${sessionValue}` });
      const bare = await view({ cookie: `dms_session=${sessionValue}` });
      const anonymous = await view({});
      const body = bodyJson(valid);
      observe(ctx, "GET /api/_auth/session shows what the browser may know", { valid: body, tampered: bodyJson(tampered), anonymous: bodyJson(anonymous) }, [
        ctx.equal("a valid cookie shows the user and the session's account, tenant and write time", [keysOf(body).sort(), keysOf(rowAt(body, "session")).sort(), isNumber(at(body, "session", "updatedAt"))], [["session", "user"], ["accountId", "activeTenantId", "updatedAt"], true]),
        ctx.equal("the user is the signed-in account", textAt(body, "user", "email"), credentials.email),
        ctx.equal("the answer holds no token", tokenWords.test(valid.text), false),
        ctx.equal("a tampered, truncated, garbage, other-backend or unscoped cookie shows nobody", [tampered, truncated, garbage, otherScope, bare, anonymous].map((answer) => [answer.status, bodyJson(answer)]), [200, 200, 200, 200, 200, 200].map((status) => [status, {}])),
      ]);

      const refresh = await exchange(web, { method: "POST", path: "/api/_auth/session", headers: { origin: web, cookie } });
      const refreshed = bodyJson(refresh);
      const refreshCookies = setCookies(refresh);
      observe(ctx, "POST /api/_auth/session renews and re-stamps the session", { refreshed, cookies: refreshCookies.map(withoutValue) }, [
        ctx.equal("it answers the session as the browser sees it", [refresh.status, textAt(refreshed, "user", "email"), textAt(refreshed, "session", "accountId")], [200, credentials.email, textAt(body, "session", "accountId")]),
        ctx.holds("the write time moved forward", (numberAt(refreshed, "session", "updatedAt") ?? 0) >= (numberAt(body, "session", "updatedAt") ?? Infinity), `${String(at(body, "session", "updatedAt"))} -> ${String(at(refreshed, "session", "updatedAt"))}`),
        ctx.equal("the renewed session is written with the same attributes", withoutValue(lineOf(refreshCookies, `dms_session_${scope}=`)), `dms_session_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MONTH}; Secure`),
      ]);

      /** @type {Record<string, (string | string[] | undefined)[]>} */
      const methods = {};
      for (const method of ["HEAD", "PUT", "PATCH", "OPTIONS"]) {
        const answer = await exchange(web, { method, path: "/api/_auth/session" });
        methods[method] = [answer.status, answer.headers.allow, method === "HEAD" ? "" : answer.text];
      }
      const noOrigin = await exchange(web, { method: "DELETE", path: "/api/_auth/session", headers: { cookie } });
      const noOriginPost = await exchange(web, { method: "POST", path: "/api/_auth/session", headers: { cookie } });
      const noOriginLogin = await exchange(web, { method: "POST", path: "/auth/login", headers: { "content-type": "application/json" }, body: "{}" });
      const stillIn = await view({ cookie });
      const out = await exchange(web, { method: "DELETE", path: "/api/_auth/session", headers: { origin: web, cookie } });
      const outCookies = setCookies(out);
      observe(ctx, "sign out, and the same-origin rule on the session routes", { methods, out: outCookies.map(withoutValue) }, [
        ctx.equal("any other method is 405 with Allow, and needs no Origin", Object.values(methods), [[405, "GET, POST, DELETE", ""], [405, "GET, POST, DELETE", '{"error":"Method Not Allowed"}'], [405, "GET, POST, DELETE", '{"error":"Method Not Allowed"}'], [405, "GET, POST, DELETE", '{"error":"Method Not Allowed"}']]),
        ctx.equal("DELETE, POST and a login without Origin are refused", [noOrigin, noOriginPost, noOriginLogin].map((answer) => [answer.status, bodyJson(answer)]), [[403, CROSS_ORIGIN], [403, CROSS_ORIGIN], [403, CROSS_ORIGIN]]),
        ctx.equal("the refused DELETE left the session in place", Object.keys(bodyJson(stillIn)).sort(), ["session", "user"]),
        ctx.equal("DELETE signs out: the session, account index and account cookies are expired", [out.status, withoutValue(lineOf(outCookies, `dms_session_${scope}=`)), withoutValue(lineOf(outCookies, `dms_account_index_${scope}=`))], [200, `dms_session_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`, `dms_account_index_${scope}=VALUE; Path=/; HttpOnly; SameSite=Lax; Secure`]),
      ]);

      const tab = await ctx.tab("admin");
      await tab.signIn("admin");
      await tab.goto("/settings");
      const jar = await tab.page.context().cookies();
      const sessionCookie = jar.find((entry) => entry.name === `dms_session_${scope}`);
      const visible = await tab.page.evaluate(() => document.cookie);
      const html = await tab.page.content();
      const pageSession = await tab.page.evaluate(() => fetch("/api/_auth/session").then((response) => response.json()));
      observe(ctx, "in the browser", { sessionCookie: { ...sessionCookie, value: "VALUE" }, visible, pageSession }, [
        ctx.equal("the browser's jar holds the session cookie as HttpOnly, SameSite=Lax and Secure", [sessionCookie?.httpOnly, sessionCookie?.sameSite, sessionCookie?.secure, sessionCookie?.path], [true, "Lax", true, "/"]),
        ctx.equal("script cannot read it: document.cookie lacks every dms_session", visible.includes("dms_session"), false),
        ctx.equal("the page props carry the user and session view, no token", [/"accessToken"|"refreshToken"|access_token|refresh_token/.test(html), Object.keys(pageSession).sort()], [false, ["session", "user"]]),
      ]);

      const { handler } = fakeAuthBackend();
      /** @type {[string, Record<string, string>, boolean][]} */
      const secureCases = [["DMS_COOKIE_SECURE=false", { DMS_COOKIE_SECURE: "false" }, false], ["DMS_COOKIE_SECURE=0", { DMS_COOKIE_SECURE: "0" }, true], ["DMS_COOKIE_SECURE=true", { DMS_COOKIE_SECURE: "true" }, true]];
      for (const [label, env, secure] of secureCases) {
        await withSatellite(ctx, { backend: handler, env }, async (server) => {
          const entry = await signIn(server);
          const line = lineOf(entry.cookies, "dms_session_");
          observe(ctx, `start with ${label}`, { line: withoutValue(line) }, [
            ctx.equal(`the cookie is ${secure ? "" : "not "}Secure`, / Secure$|; Secure;/.test(line), secure),
          ]);
        });
      }
      await withSatellite(ctx, { backend: handler, apiHost: "localhost" }, async (server) => {
        const entry = await signIn(server);
        const name = /^(dms_session_[0-9a-f]{12})=/.exec(lineOf(entry.cookies, "dms_session_"))?.[1];
        const canonical = `http://127.0.0.1:${server.backend.port}`;
        observe(ctx, "a backend named localhost shares the cookie of 127.0.0.1", { name, canonical }, [
          ctx.equal("the suffix hashes the URL with localhost read as 127.0.0.1", name, `dms_session_${scopeOf(canonical)}`),
        ]);
      });
    },
  },
];
