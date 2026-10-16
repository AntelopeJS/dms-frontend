import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBrotliCompress,
  createGzip,
  constants as zlibConstants,
} from "node:zlib";

/** Below this size, compressing saves less than it costs. */
export const MINIMUM_COMPRESSION_BYTES = 1_024;
const DYNAMIC_BROTLI_QUALITY = 4;

/**
 * A compressor for a body generated or relayed now, in the encoding the client
 * accepts (Brotli first), or `undefined` when it accepts neither. `streaming`
 * flushes what each write gives at once, for a body written over time: the
 * client gets each part when it is written, not when a block fills.
 */
export function acceptedEncoder(request, { streaming = false } = {}) {
  const accepted = request.headers["accept-encoding"] ?? "";
  if (accepted.includes("br"))
    return {
      encoding: "br",
      stream: createBrotliCompress({
        ...(streaming && { flush: zlibConstants.BROTLI_OPERATION_FLUSH }),
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY,
        },
      }),
    };
  if (accepted.includes("gzip"))
    return {
      encoding: "gzip",
      stream: createGzip(
        streaming ? { flush: zlibConstants.Z_SYNC_FLUSH } : {},
      ),
    };
}

function responseEncoder(request, content) {
  if (Buffer.byteLength(content) < MINIMUM_COMPRESSION_BYTES) return undefined;
  return acceptedEncoder(request);
}

/** Send a generated body, compressed when the client accepts it. */
export async function writeContent(
  request,
  response,
  status,
  headers,
  content,
) {
  const encoder = responseEncoder(request, content);
  const vary = [headers.vary, "Accept-Encoding"].filter(Boolean).join(", ");
  const encodedHeaders = { ...headers, vary };
  if (!encoder) {
    response.writeHead(status, encodedHeaders);
    response.end(content);
    return;
  }
  encodedHeaders["content-encoding"] = encoder.encoding;
  response.writeHead(status, encodedHeaders);
  await pipeline(Readable.from([content]), encoder.stream, response);
}
