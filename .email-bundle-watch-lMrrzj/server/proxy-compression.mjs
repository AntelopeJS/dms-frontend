import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { acceptedEncoder, MINIMUM_COMPRESSION_BYTES } from "./content.mjs";
import { writeProxyHeaders } from "./proxy-headers.mjs";

/**
 * Asks the backend for its answer uncompressed. fetch decodes a compressed
 * answer but keeps its Content-Encoding and Content-Length, which then
 * described bytes the client never got: the proxy compresses for the client
 * itself (see proxyEncoder).
 */
export const PLAIN_ANSWER_HEADERS = { "accept-encoding": "identity" };

// Text the backend sends uncompressed: JSON above all, which the antelope API
// module never compresses. An event stream is left as it is: its events are
// small and many, and proxies between here and the browser expect it plain.
const COMPRESSIBLE_TYPE =
  /^(?:text\/(?!event-stream)[\w.+-]+|application\/(?:[\w.-]+\+)?(?:json|xml|javascript|ecmascript)|image\/svg\+xml)\s*(?:;|$)/i;
// Statuses that carry no body to compress.
const BODILESS_STATUSES = new Set([204, 205, 304]);

/** Whether the backend answer is one to compress on its way to the client. */
function isCompressible(request, upstream) {
  if (request.method === "HEAD" || !upstream.body) return false;
  if (BODILESS_STATUSES.has(upstream.status)) return false;
  const headers = upstream.headers;
  // Already encoded, or a range of the bytes: compressing would change what
  // the encoding or the range describes.
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
 */
function proxyEncoder(request, upstream) {
  // Streaming: an answer of unknown length (chunked JSON, streamed text)
  // reaches the client part by part, as the backend writes it.
  return isCompressible(request, upstream)
    ? acceptedEncoder(request, { streaming: true })
    : undefined;
}

/** Relays a backend answer to the client, compressed when it should be. */
export async function relayAnswer(
  request,
  response,
  upstream,
  { fetched = false } = {},
) {
  // Only native fetch bodies are decoded. Synthetic/opaque responses may
  // still contain the encoded bytes, and unknown coding chains stay opaque.
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
    // A decoded partial representation cannot retain the encoded byte offsets.
    // Do not manufacture a complete 200 response from a partial 206 either.
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
    upstream = { status: upstream.status, headers, body: upstream.body };
  }
  const encoder = proxyEncoder(request, upstream);
  writeProxyHeaders(
    response,
    upstream,
    encoder?.encoding,
    isCompressible(request, upstream),
  );
  if (!upstream.body || request.method === "HEAD") return response.end();
  const body = Readable.fromWeb(upstream.body);
  if (encoder) await pipeline(body, encoder.stream, response);
  else await pipeline(body, response);
}
