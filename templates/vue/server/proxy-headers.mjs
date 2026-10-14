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

/** Writes the backend's status and end-to-end headers on `response`. */
export function writeProxyHeaders(response, upstream) {
  const headers = Object.fromEntries(upstream.headers);
  const named = (headers.connection ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase());
  for (const name of [...HOP_BY_HOP_HEADERS, ...named]) delete headers[name];
  delete headers["set-cookie"];
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  response.writeHead(upstream.status, headers);
}
