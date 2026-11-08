import { isString } from "./type-guards.mjs";

const FRONTEND_ORIGIN = "http://frontend.local";

/**
 * Whether `target` is an origin-form request target: a path, optionally with a
 * query, that stays on this server once resolved. Anything else (an absolute
 * or authority form, `*`, a path a URL parser reads as another host) is not a
 * request a browser sends to the frontend.
 *
 * @param {string | undefined} target
 */
export function isOriginForm(target) {
  if (!isString(target) || !target.startsWith("/")) return false;
  try {
    return new URL(target, FRONTEND_ORIGIN).origin === FRONTEND_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * The backend URL a request target is proxied to: the target's normalized path
 * and query on the backend's origin. The path is set, not resolved, so a path
 * normalizing to `//host` (`/x/..//host`) stays a path on the backend.
 *
 * @param {string} target The request target, origin-form
 * @param {string} [backendBaseUrl] The backend's base URL
 */
export function backendUrl(
  target,
  backendBaseUrl = process.env.DMS_API_BASE_URL ?? "",
) {
  const { pathname, search } = new URL(target, FRONTEND_ORIGIN);
  const url = new URL(new URL(backendBaseUrl).origin);
  url.pathname = pathname;
  url.search = search;
  return url;
}

/**
 * A request a server received, whose `url` and `method` Node always sets
 * (`isServerRequest`).
 *
 * @typedef {import("node:http").IncomingMessage & { url: string, method: string }} ServerRequest
 */

/**
 * @template {import("node:http").IncomingMessage} Request
 * @param {Request} request
 * @returns {request is Request & ServerRequest}
 */
export function isServerRequest(request) {
  return isString(request.url) && isString(request.method);
}

/**
 * Whether the request target is origin-form, the only kind the server routes:
 * a request that fails it is answered 400 before any route reads it.
 *
 * The request target as the server reads it. Node hands `request.url` over
 * verbatim, so it is not always a path: `//host/x`, `/\host/x` and the absolute
 * form `http://host/x` all name another host once resolved, which turned the
 * proxy into an open one. Every routing decision and the URL sent to the
 * backend read the same normalized path from here.
 *
 * @param {import("node:http").IncomingMessage} request
 * @returns {request is ServerRequest}
 */
export function hasOriginFormTarget(request) {
  return isString(request.method) && isOriginForm(request.url);
}
