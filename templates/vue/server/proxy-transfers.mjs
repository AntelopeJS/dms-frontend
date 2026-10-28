const PAYLOAD_TOO_LARGE = 413;
const TOO_LARGE_BODY = JSON.stringify({ message: "Payload Too Large" });
/**
 * The refused body is never passed on: the iteration stops where it went
 * over, and the request stream stays open for the lingering close below.
 */
const BODY_ITERATION = { destroyOnReturn: false };
/**
 * How long a refused body is read and dropped before the connection closes
 * anyway: long enough for a client to finish sending what was in flight,
 * short enough to bound what a refused client can make the server read.
 */
const LINGER_MS = 5_000;

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

/**
 * Answers 413 and closes the connection once the client stopped sending.
 *
 * Closing a socket with unread bytes makes the kernel reset the connection,
 * and a client stack that drops what it had not read yet when the reset
 * arrives (macOS, BSD, Windows) reports a network error instead of the 413,
 * the browser's upload failing without a reason. The rest of the body is read
 * and dropped instead (RFC 9112, section 9.6, "tear-down"), for `LINGER_MS`
 * at most; the response ends with it and the connection then closes cleanly.
 */
function refuseTooLargeBody(request, response) {
  response.writeHead(PAYLOAD_TOO_LARGE, {
    "content-type": "application/json",
    connection: "close",
  });
  response.write(TOO_LARGE_BODY);
  if (request.complete) return response.end();
  const close = () => {
    clearTimeout(timer);
    response.end();
  };
  const timer = setTimeout(() => {
    response.end();
    request.socket.destroy();
  }, LINGER_MS);
  timer.unref();
  request.once("end", close);
  request.once("error", close);
  request.resume();
}

/**
 * Sends a proxied request, its body held to `maxBodyBytes`.
 *
 * Large transfers through the proxy, a file upload above all. The request body
 * is streamed to the backend, never buffered, and held to the `maxBodyBytes` of
 * the proxy it reached: a declared Content-Length over the limit is refused
 * before a byte is passed on, a chunked body is cut off as soon as it goes
 * over.
 *
 * @param send `(body) => Promise<Response>`, the backend request with the
 *   body to stream: none for a GET or a HEAD, the request itself, or its
 *   bytes cut off past the limit
 * @returns The backend's answer, or `undefined` once the body went over and
 *   `response` got the 413
 */
export async function sendWithinLimit(request, response, maxBodyBytes, send) {
  if (declaresTooLargeBody(request, maxBodyBytes))
    return refuseTooLargeBody(request, response);
  try {
    return await send(requestBody(request, maxBodyBytes));
  } catch (error) {
    if (!isBodyTooLarge(error)) throw error;
    return refuseTooLargeBody(request, response);
  }
}
