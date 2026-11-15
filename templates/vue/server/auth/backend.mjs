import { REDIRECT_STATUSES } from "../proxy-redirects.mjs";
import { isObjectLike, isString } from "../type-guards.mjs";
import {
  clientCountryHeader,
  clientIp,
  clientIpHeader,
  isSameOrigin,
} from "./client-ip.mjs";

/**
 * The client headers every backend request carries, the proxy's and a module
 * route's alike: the browser's user agent, the interface language, and the
 * realtime session and the browser connection it rides on.
 */
export const CLIENT_HEADERS = [
  "user-agent",
  "x-content-language",
  "x-realtime-session",
  "x-realtime-connection",
];

/**
 * The prefix of the request headers a module's client code sets on its own
 * requests, which every backend request carries as the browser sent them: no
 * HTML form can set a header, so a backend route can require one to refuse a
 * submission a page built from blocks makes with the user's session.
 */
export const UI_HEADER_PREFIX = "x-dms-ui-";

/**
 * Whether the browser marked `request` as sent from another origin: an
 * `Origin` that is not this server's, or a `Sec-Fetch-Site` other than
 * `same-origin`. A request with neither, from a client that is no browser,
 * is not.
 *
 * @param {import("./client-ip.mjs").ForwardedRequest} request
 */
function isCrossOrigin(request) {
  const site = request.headers["sec-fetch-site"];
  return (
    (request.headers.origin !== undefined && !isSameOrigin(request)) ||
    (site !== undefined && site !== "same-origin")
  );
}

/**
 * The `x-dms-ui-*` headers of a client request, none when the browser sent it
 * from another origin.
 *
 * @param {import("./client-ip.mjs").ForwardedRequest} request
 * @returns {Record<string, string>}
 */
function uiHeaders(request) {
  if (isCrossOrigin(request)) return {};
  return Object.fromEntries(
    Object.entries(request.headers).flatMap(([name, value]) =>
      name.startsWith(UI_HEADER_PREFIX) && value !== undefined
        ? [[name, String(value)]]
        : [],
    ),
  );
}

export class UpstreamError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PUBLIC_AUTH_MESSAGE = /^error\.[a-z0-9_.-]{1,100}$/;
/**
 * The API error contract's generic key: the technical cause of a failure the
 * backend did not describe stays in the server log.
 */
export const GENERIC_ERROR_MESSAGE = "error.500.description";

/**
 * @param {unknown} data A backend answer: any JSON value, or the text of one
 *   that is not JSON
 * @returns {string | undefined}
 */
export function publicBackendMessage(data) {
  /** @type {unknown} */
  const message = isObjectLike(data) ? data.message : data;
  return isString(message) && PUBLIC_AUTH_MESSAGE.test(message)
    ? message
    : undefined;
}

/**
 * The headers of a client request the server relays to the backend.
 *
 * @param {import("./client-ip.mjs").ForwardedRequest} request The client
 *   request
 * @param {readonly string[]} names Lowercase names of the request headers to
 *   copy when present
 * @returns The client country header, the `x-dms-ui-*` headers of a request
 *   the browser did not mark as sent from another origin, then the copied
 *   headers
 */
export function relayedHeaders(request, names) {
  return {
    ...clientCountryHeader(request),
    ...uiHeaders(request),
    ...Object.fromEntries(
      names.flatMap((name) =>
        request.headers[name] ? [[name, String(request.headers[name])]] : [],
      ),
    ),
  };
}

/**
 * Calls the backend for a server route, JSON in and out.
 *
 * `options.headers` adds request headers; the client's address and the
 * relayed client headers are set after them, so no caller replaces those, and
 * an `x-dms-ui-*` header among them is dropped: the backend sees one only when
 * the client sent it.
 * A redirect is not followed: it is no JSON answer, so it fails with a 502.
 *
 * @param {string} path
 * @param {import("./client-ip.mjs").ForwardedRequest} request The client
 *   request
 * @param {{
 *   method?: string,
 *   body?: unknown,
 *   token?: string,
 *   relay?: boolean,
 *   headers?: Record<string, string>
 * }} [options]
 * @returns {Promise<unknown>} The answer's JSON, `{}` for a successful one that
 *   is not JSON
 */
export async function backend(path, request, options = {}) {
  /** @type {Record<string, string>} */
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).flatMap(([name, value]) =>
      name.toLowerCase().startsWith(UI_HEADER_PREFIX)
        ? []
        : [[name.toLowerCase(), String(value)]],
    ),
  );
  Object.assign(headers, relayedHeaders(request, CLIENT_HEADERS));
  headers["x-forwarded-for"] = clientIp(request);
  Object.assign(headers, clientIpHeader(request));
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.relay)
    headers["x-dms-oauth-relay"] = process.env.DMS_OAUTH_RELAY_SECRET ?? "";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, process.env.DMS_API_BASE_URL), {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual",
  });
  if (REDIRECT_STATUSES.has(response.status)) {
    await response.body?.cancel();
    console.error(
      `DMS backend request redirected: ${response.status} ${options.method ?? "GET"} ${path}`,
    );
    throw new UpstreamError(502, GENERIC_ERROR_MESSAGE);
  }
  const text = await response.text();
  /** @type {unknown} */
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = response.ok ? {} : text;
  }
  if (!response.ok) {
    const message = publicBackendMessage(data);
    if (!message)
      console.error(
        `DMS backend request failed: ${response.status} ${options.method ?? "GET"} ${path}`,
      );
    throw new UpstreamError(response.status, message ?? GENERIC_ERROR_MESSAGE);
  }
  return data;
}

export class RequestBodyError extends Error {
  /**
   * @param {number} status
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {unknown} value Anything `JSON.stringify` writes
 */
export function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
