import { relayedLocation } from "./proxy-redirects.mjs";

// Hop-by-hop headers describe the backend connection, not the client's one.
// Forwarded, an explicit `connection: keep-alive` overrode the client's own
// `Connection: close`, so Node kept the socket open until its idle timeout.
const HOP_BY_HOP_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

/** `Accept-Encoding` added to the backend's own `Vary`, once. */
function varyWithEncoding(vary) {
  const names = (vary ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.some((name) => name === "*" || /^accept-encoding$/i.test(name)))
    return names.join(", ");
  return [...names, "Accept-Encoding"].join(", ");
}

/**
 * Writes the backend's status and end-to-end headers on `response`. With an
 * `encoding`, the proxy compresses the body itself: its length is no longer
 * known, and a strong validator no longer names these bytes. A `Location` on
 * the backend's origin becomes the same path on the frontend's when
 * `isProxiedPath` says the frontend proxies it (see `relayedLocation`).
 */
export function writeProxyHeaders(
  response,
  upstream,
  encoding,
  varies = false,
  isProxiedPath,
) {
  const headers = Object.fromEntries(upstream.headers);
  const named = (headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_BY_HOP_HEADERS, ...named]) delete headers[name];
  delete headers["set-cookie"];
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  if (headers.location && upstream.url)
    headers.location = relayedLocation(
      headers.location,
      upstream.url,
      isProxiedPath,
    );
  if (encoding || varies) headers.vary = varyWithEncoding(headers.vary);
  if (encoding) {
    delete headers["content-length"];
    headers["content-encoding"] = encoding;
    if (headers.etag && !headers.etag.startsWith("W/"))
      headers.etag = `W/${headers.etag}`;
  }
  response.writeHead(upstream.status, headers);
}
