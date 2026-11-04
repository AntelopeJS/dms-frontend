import { acceptedEncoder, MINIMUM_COMPRESSION_BYTES } from "./content.mjs";
import { writeProxyHeaders } from "./proxy-headers.mjs";
import { pipeWebBody } from "./web-body.mjs";

/**
 * Asks the backend for its answer uncompressed. fetch decodes a compressed
 * answer but keeps its Content-Encoding and Content-Length, which then
 * described bytes the client never got: the proxy compresses for the client
 * itself (see proxyEncoder).
 */
export const PLAIN_ANSWER_HEADERS = { "accept-encoding": "identity" };

/**
 * Text the backend sends uncompressed: JSON above all, which the antelope
 * API module never compresses. An event stream is left as it is: its events
 * are small and many, and proxies between here and the browser expect it
 * plain.
 */
const COMPRESSIBLE_TYPE =
  /^(?:text\/(?!event-stream)[\w.+-]+|application\/(?:[\w.-]+\+)?(?:json|xml|javascript|ecmascript)|image\/svg\+xml)\s*(?:;|$)/i;
const BODILESS_STATUSES = new Set([204, 205, 304]);

/**
 * What the proxy relays of a backend answer: a fetched `Response`, or the
 * same fields without its content coding.
 *
 * @typedef {Pick<Response, "status" | "headers" | "body" | "url">} ProxiedAnswer
 */

/**
 * Whether the backend answer is one to compress on its way to the client.
 *
 * A response already encoded, or a range of the bytes, is not compressed:
 * compressing would change what the encoding or the range describes.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {ProxiedAnswer} upstream
 * @returns {boolean}
 */
function isCompressible(request, upstream) {
  if (request.method === "HEAD" || !upstream.body) return false;
  if (BODILESS_STATUSES.has(upstream.status)) return false;
  const headers = upstream.headers;
  const encoding = headers.get("content-encoding");
  if (encoding && encoding.toLowerCase() !== "identity") return false;
  if (upstream.status === 206 || headers.has("content-range")) return false;
  if (
    /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(headers.get("cache-control") ?? "")
  )
    return false;
  if (!COMPRESSIBLE_TYPE.test(headers.get("content-type") ?? "")) return false;
  const length = headers.get("content-length");
  return length === null || Number(length) >= MINIMUM_COMPRESSION_BYTES;
}

/**
 * The compressor for a backend answer the proxy relays, in the encoding the
 * client accepts, or `undefined` to relay it as it came.
 *
 * Streaming: an answer of unknown length (chunked JSON, streamed text) reaches
 * the client part by part, as the backend writes it.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {ProxiedAnswer} upstream
 */
function proxyEncoder(request, upstream) {
  return isCompressible(request, upstream)
    ? acceptedEncoder(request, { streaming: true })
    : undefined;
}

/**
 * Relays a backend answer to the client, compressed when it should be.
 * `isProxiedPath` decides which backend `Location` becomes a frontend path.
 *
 * Only native fetch bodies are decoded. Synthetic or opaque responses may still
 * contain the encoded bytes, and unknown coding chains stay opaque.
 *
 * A decoded partial representation cannot retain the encoded byte offsets, and
 * a complete 200 response is not manufactured from a partial 206 either.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {ProxiedAnswer} upstream
 * @param {{
 *   fetched?: boolean,
 *   isProxiedPath?: (pathname: string) => boolean
 * }} [options]
 */
export async function relayAnswer(
  request,
  response,
  upstream,
  { fetched = false, isProxiedPath } = {},
) {
  const codings = (upstream.headers.get("content-encoding") ?? "")
    .toLowerCase()
    .split(",")
    .map((coding) => coding.trim());
  if (
    fetched &&
    request.method !== "HEAD" &&
    upstream.body &&
    !BODILESS_STATUSES.has(upstream.status) &&
    codings.every((coding) =>
      ["gzip", "x-gzip", "deflate", "br"].includes(coding),
    )
  ) {
    if (upstream.status === 206 || upstream.headers.has("content-range")) {
      await upstream.body.cancel();
      response.writeHead(502);
      response.end();
      return;
    }
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    const etag = headers.get("etag");
    if (etag && !etag.startsWith("W/")) headers.set("etag", `W/${etag}`);
    upstream = {
      status: upstream.status,
      headers,
      body: upstream.body,
      url: upstream.url,
    };
  }
  const encoder = proxyEncoder(request, upstream);
  writeProxyHeaders(
    response,
    upstream,
    encoder?.encoding,
    isCompressible(request, upstream),
    isProxiedPath,
  );
  if (!upstream.body || request.method === "HEAD") return response.end();
  if (encoder) await pipeWebBody(upstream.body, encoder.stream, response);
  else await pipeWebBody(upstream.body, response);
}
