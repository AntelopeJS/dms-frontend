import { backendHeaders } from "./backend-request.mjs";
import { PLAIN_ANSWER_HEADERS, relayAnswer } from "./proxy-compression.mjs";
import { sendWithinLimit } from "./proxy-transfers.mjs";
import { proxyAccess, refuseCrossOrigin } from "./public-endpoints.mjs";
import { backendUrl } from "./request-target.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * A backend that budgets by declared size counts a body without its
 * Content-Length as the largest it accepts, so a body's declared length goes
 * on with it.
 *
 * @param {import("./request-target.mjs").ServerRequest} request
 * @returns {{ "content-length"?: string }}
 */
function declaredLength(request) {
  const length = request.headers["content-length"];
  return SAFE_METHODS.has(request.method) || length === undefined
    ? {}
    : { "content-length": length };
}

/**
 * Sends a request to the backend through the proxy it reached.
 * `isProxiedPath` says which backend paths a relayed `Location` may name on
 * the frontend's origin.
 *
 * A client that left while the request was routed closed the response already,
 * and would never abort the request below.
 *
 * Cancelling the body alone misses a client that leaves before the backend
 * answers: its stream, an SSE feed above all, then stayed open for good.
 *
 * A backend redirect is the browser's to follow: Media sends a file's link to
 * the storage's signed URL, on the public origin the server itself may not
 * reach, which turned every download into a 502.
 *
 * @param {import("./request-target.mjs").ServerRequest} request
 * @param {import("node:http").ServerResponse} response
 * @param {import("./backend-proxies.mjs").BackendProxy} backendProxy
 * @param {(path: string) => boolean} isProxiedPath
 * @returns {Promise<true | undefined>}
 */
export async function proxy(request, response, backendProxy, isProxiedPath) {
  const access = proxyAccess(request, SAFE_METHODS, backendProxy);
  if (access.isRefused) {
    refuseCrossOrigin(response);
    return true;
  }
  if (response.closed) return;
  const abandoned = new AbortController();
  response.once("close", () => abandoned.abort());
  /** @type {RequestInit} */
  const init = {
    signal: abandoned.signal,
    method: request.method,
    headers: {
      ...backendHeaders(request, access),
      ...declaredLength(request),
      ...PLAIN_ANSWER_HEADERS,
    },
    duplex: "half",
    redirect: "manual",
  };
  const upstream = await sendWithinLimit(
    request,
    response,
    backendProxy.maxBodyBytes,
    (body) => fetch(backendUrl(request.url), { ...init, body }),
  );
  if (!upstream) return true;
  await relayAnswer(request, response, upstream, {
    fetched: true,
    isProxiedPath,
  });
}
