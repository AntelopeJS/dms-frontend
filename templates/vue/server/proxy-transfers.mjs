// Large transfers through the proxy, a file upload above all. The request
// body is streamed to the backend, never buffered, and held to the
// `maxBodyBytes` of the proxy it reached: a declared Content-Length over the
// limit is refused before a byte is read, a chunked body is cut off as soon as
// it goes over.

const PAYLOAD_TOO_LARGE = 413;
const TOO_LARGE_BODY = JSON.stringify({ message: "Payload Too Large" });
// Reading on after the refusal would take the whole body the limit exists to
// refuse, so the request stream is left as it is and the connection closed.
const BODY_ITERATION = { destroyOnReturn: false };

const BODILESS_METHODS = new Set(["GET", "HEAD"]);
const REQUEST_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The frontend server's options. Node's default request timeout (5 minutes to
 * receive a whole request) cut off a large upload on a slow link: an hour lets
 * 500 MiB through at about 150 KB/s. Headers keep Node's own minute.
 */
export const SERVER_OPTIONS = Object.freeze({
  requestTimeout: REQUEST_TIMEOUT_MS,
});

class BodyTooLargeError extends Error {}

async function* limitedChunks(request, maxBodyBytes) {
  let received = 0;
  for await (const chunk of request.iterator(BODY_ITERATION)) {
    received += chunk.byteLength;
    if (received > maxBodyBytes) throw new BodyTooLargeError();
    yield chunk;
  }
}

function requestBody(request, maxBodyBytes) {
  if (BODILESS_METHODS.has(request.method)) return undefined;
  return maxBodyBytes === undefined
    ? request
    : limitedChunks(request, maxBodyBytes);
}

function declaresTooLargeBody(request, maxBodyBytes) {
  return (
    maxBodyBytes !== undefined &&
    Number(request.headers["content-length"] ?? 0) > maxBodyBytes
  );
}

function isBodyTooLarge(error) {
  return (
    error instanceof BodyTooLargeError ||
    error?.cause instanceof BodyTooLargeError
  );
}

/** Answers 413 and closes the connection, the rest of the body unread. */
function refuseTooLargeBody(response) {
  response.writeHead(PAYLOAD_TOO_LARGE, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(TOO_LARGE_BODY);
}

/**
 * Sends a proxied request, its body held to `maxBodyBytes`.
 *
 * @param send `(body) => Promise<Response>`, the backend request with the
 *   body to stream: none for a GET or a HEAD, the request itself, or its
 *   bytes cut off past the limit
 * @returns The backend's answer, or `undefined` once the body went over and
 *   `response` got the 413
 */
export async function sendWithinLimit(request, response, maxBodyBytes, send) {
  if (declaresTooLargeBody(request, maxBodyBytes))
    return refuseTooLargeBody(response);
  try {
    return await send(requestBody(request, maxBodyBytes));
  } catch (error) {
    if (!isBodyTooLarge(error)) throw error;
    return refuseTooLargeBody(response);
  }
}
