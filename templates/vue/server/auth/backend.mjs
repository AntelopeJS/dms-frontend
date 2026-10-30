import { REDIRECT_STATUSES } from "../proxy-redirects.mjs";
import { isString } from "../type-guards.mjs";
import { clientCountryHeader, clientIp, clientIpHeader } from "./client-ip.mjs";

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

export class UpstreamError extends Error {
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

export function publicBackendMessage(data) {
  const message = isString(data) ? data : data?.message;
  return isString(message) && PUBLIC_AUTH_MESSAGE.test(message)
    ? message
    : undefined;
}

/**
 * The headers of a client request the server relays to the backend.
 *
 * @param request The client request
 * @param names Lowercase names of the request headers to copy when present
 * @returns The client country header, then the copied headers
 */
export function relayedHeaders(request, names) {
  return {
    ...clientCountryHeader(request),
    ...Object.fromEntries(
      names.flatMap((name) =>
        request.headers[name] ? [[name, request.headers[name]]] : [],
      ),
    ),
  };
}

/**
 * Calls the backend for a server route, JSON in and out.
 *
 * `options.headers` adds request headers; the client's address and the
 * relayed client headers are set after them, so no caller replaces those.
 * A redirect is not followed: it is no JSON answer, so it fails with a 502.
 */
export async function backend(path, request, options = {}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      String(value),
    ]),
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
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
