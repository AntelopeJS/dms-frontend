import { Buffer } from "node:buffer";
import { exchange, bodyJson } from "./proxy-http.mjs";
import { parseJson, textAt } from "./json.mjs";

/**
 * A JWT-shaped access token: the frontend reads the tenant out of its payload.
 *
 * @param {string} tenantId The tenant the token names
 * @returns {string} The token
 */
export function accessToken(tenantId = "tenant-1") {
  /** @param {unknown} value Anything to encode */
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ tenantId })}.signature`;
}

export const FAKE_USER = Object.freeze({ _id: "user-1", email: "fake@verify.local", name: "Fake User" });

/**
 * @typedef {object} FakeAuth
 * @property {string[]} refreshes The refresh tokens the backend received
 * @property {number} version Counter the access tokens carry, bumped by each refresh
 * @property {string} current The access token the backend accepts
 * @property {number} logins How many logins the backend answered
 * @property {boolean} refuse Whether refreshes are refused with 401
 */

/**
 * A backend that implements the sign-in routes of the DMS well enough for
 * the frontend server's own session logic to run: login, refresh, me and
 * logout. Everything else goes to `fallback`.
 *
 * @param {import("./proxy-satellite.mjs").BackendHandler} [fallback] Answers every other route
 * @param {{ refreshDelayMs?: number }} [options] How slowly the backend renews
 * @returns {{ handler: import("./proxy-satellite.mjs").BackendHandler, auth: FakeAuth }} The handler and its state
 */
export function fakeAuthBackend(fallback, options = {}) {
  /** @type {FakeAuth} */
  const auth = { refreshes: [], version: 1, current: accessToken("tenant-1"), logins: 0, refuse: false };
  /**
   * @param {import("node:http").ServerResponse} response The response
   * @param {number} status The status
   * @param {unknown} value The JSON body
   */
  const json = (response, status, value) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
  /** @type {import("./proxy-satellite.mjs").BackendHandler} */
  const handler = (request, response, seen) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/api/auth/login" && request.method === "POST") {
      return void request.resume().on("end", () => {
        auth.logins += 1;
        json(response, 200, { access_token: auth.current, refresh_token: `refresh-login-${auth.logins}`, user: FAKE_USER });
      });
    }
    if (path === "/api/auth/refresh" && request.method === "POST") {
      return void request.on("data", (/** @type {Buffer} */ part) => auth.refreshes.push(textAt(parseJson(part.toString()), "token") ?? "")).on("end", () => {
        setTimeout(() => {
          if (auth.refuse) return json(response, 401, { message: "error.refresh_refused" });
          auth.version += 1;
          auth.current = accessToken(`tenant-${auth.version}`);
          return json(response, 200, { access_token: auth.current, refresh_token: `refresh-${auth.version}` });
        }, options.refreshDelayMs ?? 0);
      });
    }
    if (path === "/api/auth/me") return json(response, 200, FAKE_USER);
    if (path === "/api/auth/logout") return void request.resume().on("end", () => json(response, 200, {}));
    if (fallback) return fallback(request, response, seen);
    return json(response, 200, { ok: true });
  };
  return { handler, auth };
}

/**
 * @param {import("./proxy-http.mjs").Exchange} answer An answer
 * @returns {string[]} The `Set-Cookie` lines
 */
export function setCookies(answer) {
  const value = answer.headers["set-cookie"];
  return Array.isArray(value) ? value : value ? [value] : [];
}

/**
 * The `Cookie` request header a browser would send back for these `Set-Cookie` lines.
 *
 * @param {string[]} cookies The `Set-Cookie` lines
 * @returns {string} The header value
 */
export function cookieHeader(cookies) {
  return cookies
    .map((line) => line.split(";")[0])
    .filter((pair) => !/^[^=]+=$/.test(pair))
    .join("; ");
}

/**
 * Signs in through the server's own `POST /auth/login`.
 *
 * @param {{ url: string }} server The frontend server
 * @param {{ keepLogin?: boolean, origin?: string }} [options] Whether to ask to be kept signed in
 * @returns {Promise<{ answer: import("./proxy-http.mjs").Exchange, cookies: string[], cookie: string, body: unknown }>} The answer and the cookies it set
 */
export async function signIn(server, options = {}) {
  const answer = await exchange(server.url, {
    method: "POST",
    path: "/auth/login",
    headers: { origin: options.origin ?? server.url, "content-type": "application/json" },
    body: JSON.stringify({ email: FAKE_USER.email, password: "irrelevant", keep_login: options.keepLogin === true }),
  });
  const cookies = setCookies(answer);
  return { answer, cookies, cookie: cookieHeader(cookies), body: bodyJson(answer) };
}
