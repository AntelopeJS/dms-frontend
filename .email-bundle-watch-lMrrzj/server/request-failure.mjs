// Answers for requests the server cannot serve at all: an unreadable URL, or a
// failure while it was already rendering the error page.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows.

const FRONTEND_ORIGIN = "http://frontend.local";
const TEXT_TYPE = "text/plain; charset=utf-8";

/**
 * Whether the path of `url` holds a percent-escape no decoder accepts, such as
 * `/projects/%E0%A4%A`. Vite and the router decode the path, and throw on it.
 */
export function hasMalformedPath(url) {
  try {
    decodeURI(new URL(url, FRONTEND_ORIGIN).pathname);
    return false;
  } catch {
    return true;
  }
}

/**
 * Whether a failed request can no longer be answered: the client went away, or
 * the response already started.
 */
export function isResponseGone(error, response) {
  return (
    error?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    response.destroyed ||
    response.writableEnded ||
    response.headersSent
  );
}

export function writeBadRequest(response) {
  response.writeHead(400, { "content-type": TEXT_TYPE });
  response.end("Bad Request");
}

/**
 * The last resort once even the error page failed: a bare 500, or a dropped
 * connection when the response already started. The server keeps running
 * either way.
 */
export function abandonResponse(error, response) {
  console.error("DMS error response failed", error);
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(500, { "content-type": TEXT_TYPE });
  response.end("Internal Server Error");
}
