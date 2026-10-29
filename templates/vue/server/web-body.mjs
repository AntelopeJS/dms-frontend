import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Sends `body` through `streams` to the response, the last of them. A
 * response the client already left is not piped: `pipeline` refuses it
 * before it listens to the body, which then stayed unread with no `error`
 * listener, and its next failure (the backend closing, or undici's body
 * timeout on an event stream gone quiet) ended the whole server. The body is
 * cancelled instead, which closes its backend connection too.
 *
 * Writes a Web-standard body, a backend answer above all, to a Node response.
 * It lives apart from the proxy and the module routes, which both send one.
 */
export async function pipeWebBody(body, ...streams) {
  const response = streams.at(-1);
  if (response.closed || response.destroyed) {
    for (const stream of streams.slice(0, -1)) stream.destroy();
    await body.cancel().catch(() => {});
    return;
  }
  await pipeline(Readable.fromWeb(body), ...streams);
}
