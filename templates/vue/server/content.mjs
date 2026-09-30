import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  createBrotliCompress,
  createGzip,
  constants as zlibConstants,
} from "node:zlib";

const MINIMUM_COMPRESSION_BYTES = 1_024;
const DYNAMIC_BROTLI_QUALITY = 4;

function responseEncoder(request, content) {
  if (Buffer.byteLength(content) < MINIMUM_COMPRESSION_BYTES) return undefined;
  const accepted = request.headers["accept-encoding"] ?? "";
  if (accepted.includes("br"))
    return {
      encoding: "br",
      stream: createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY,
        },
      }),
    };
  if (accepted.includes("gzip"))
    return { encoding: "gzip", stream: createGzip() };
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
