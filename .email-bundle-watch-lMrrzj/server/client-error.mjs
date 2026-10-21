// Answers for requests Node rejects before the request handler runs. Without
// a `clientError` listener Node answers on its own and logs nothing, so a page
// refused for its headers left no trace in the server output.

const HEADER_OVERFLOW = "HPE_HEADER_OVERFLOW";
const HEADER_OVERFLOW_RESPONSE =
  "HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n";
const BAD_REQUEST_RESPONSE =
  "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n";
// A browser retries a refused page with the same cookies: one hint per minute
// is enough to explain them all.
const HEADER_OVERFLOW_HINT_INTERVAL_MS = 60_000;

let lastHeaderOverflowHint = -Infinity;

function warnHeaderOverflow(maxHeaderSize) {
  const now = Date.now();
  if (now - lastHeaderOverflowHint < HEADER_OVERFLOW_HINT_INTERVAL_MS) return;
  lastHeaderOverflowHint = now;
  console.warn(
    `DMS refused a request with 431: its headers exceed the ${maxHeaderSize}-byte limit. ` +
      "This is most often cookies accumulated on this host (browsers share " +
      "localhost cookies across ports); clear this site's cookies and reload.",
  );
}

/**
 * The server's `clientError` listener: explains a 431 in the logs, and
 * otherwise answers as Node does without a listener.
 */
export function handleClientError(error, socket, maxHeaderSize) {
  let response = BAD_REQUEST_RESPONSE;
  if (error.code === HEADER_OVERFLOW) {
    response = HEADER_OVERFLOW_RESPONSE;
    warnHeaderOverflow(maxHeaderSize);
  }
  // Once a response went out on this connection, a status line would land in
  // the middle of it.
  if (socket.writable && socket.bytesWritten === 0) socket.write(response);
  socket.destroy();
}
