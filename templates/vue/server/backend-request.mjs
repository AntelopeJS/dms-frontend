import { CLIENT_HEADERS, relayedHeaders } from "./auth/backend.mjs";
import { forwardedHeaders } from "./auth/client-ip.mjs";
import { readSession } from "./auth/session.mjs";
import { backendResponseError } from "./backend-response.mjs";
import { serverReads } from "./in-place-render.mjs";

/**
 * The headers of a backend request: the relayed client headers, the client's
 * Origin and Referer as received, the `X-Forwarded-*` headers (set last, so no
 * caller writes them), and the session's access token unless the request goes
 * anonymously.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {{ anonymous: boolean, headers: readonly string[] }} [access]
 * @returns {Record<string, string>}
 */
export function backendHeaders(
  request,
  access = { anonymous: false, headers: [] },
) {
  /** @type {Record<string, string>} */
  const headers = {
    ...relayedHeaders(request, [
      "accept",
      "content-type",
      "if-match",
      "origin",
      "referer",
      ...CLIENT_HEADERS,
      ...access.headers,
    ]),
    ...forwardedHeaders(request),
  };
  const session = access.anonymous ? undefined : readSession(request);
  if (session?.accessToken)
    headers.authorization = `Bearer ${session.accessToken}`;
  return headers;
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @returns {import("./in-place-render.mjs").ServerReads}
 */
export function serverComponentFetch(request) {
  return serverReads(() => backendHeaders(request));
}

/**
 * @param {string} path
 * @param {import("node:http").IncomingMessage} request
 * @returns {Promise<unknown>}
 */
export async function backendJson(path, request) {
  const response = await fetch(new URL(path, process.env.DMS_API_BASE_URL), {
    headers: backendHeaders(request),
  });
  if (!response.ok) {
    throw await backendResponseError(response);
  }
  return response.json();
}
