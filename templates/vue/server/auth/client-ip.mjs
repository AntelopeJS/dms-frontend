const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;

function headerName(value) {
  const name = (value ?? "").trim().toLowerCase();
  return HEADER_NAME.test(name) ? name : undefined;
}

function trustedHops() {
  const value = Number.parseInt(process.env.DMS_TRUSTED_PROXY_HOPS ?? "0", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/**
 * The client's address as the platform wrote it in the header
 * `DMS_CLIENT_IP_HEADER` names (antelopejs.cloud: `X-Client-IP`), if the
 * request carries it. The platform overwrites that header on every request,
 * so its presence also vouches for the platform's `X-Forwarded-*`. On a path
 * the platform does not front (a private call from another service), it is
 * absent and the request falls back to `DMS_TRUSTED_PROXY_HOPS`.
 */
function platformClientIp(request) {
  const name = headerName(process.env.DMS_CLIENT_IP_HEADER);
  if (!name) return undefined;
  const value = request.headers?.[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isProxyTrusted(request) {
  return Boolean(platformClientIp(request)) || trustedHops() > 0;
}

export function requestScheme(request) {
  if (isProxyTrusted(request)) {
    const forwarded = String(request.headers["x-forwarded-proto"] ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value === "http" || value === "https")
      .at(-1);
    if (forwarded) return forwarded;
  }
  return request.socket?.encrypted ? "https" : "http";
}

function requestHost(request) {
  if (!isProxyTrusted(request)) return request.headers.host;
  return (
    String(request.headers["x-forwarded-host"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1) || request.headers.host
  );
}

/**
 * The `X-Forwarded-*` headers of a backend request, which tell the backend
 * the client a request comes from: its address, to limit each client, and
 * the scheme and host it asked, to check an Origin against.
 *
 * Behind the platform, `X-Forwarded-For` is the address it wrote. Otherwise
 * the client's own `X-Forwarded-For` is extended only when a trusted reverse
 * proxy wrote it (`DMS_TRUSTED_PROXY_HOPS` above `0`): otherwise any caller
 * could have, and the socket's address replaces it. The scheme and the host
 * are read the same way as the CSRF origin check reads them.
 */
export function forwardedHeaders(request) {
  const headers = {
    "x-forwarded-for": forwardedFor(request),
    "x-forwarded-proto": requestScheme(request),
  };
  const host = requestHost(request);
  if (host) headers["x-forwarded-host"] = host;
  return headers;
}

function forwardedFor(request) {
  const platformIp = platformClientIp(request);
  if (platformIp) return platformIp;
  const socketIp = request.socket?.remoteAddress || "unknown";
  const incoming = trustedHops()
    ? String(request.headers["x-forwarded-for"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return [...incoming, socketIp].join(", ");
}

export function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    return (
      new URL(origin).origin ===
      new URL(`${requestScheme(request)}://${requestHost(request)}`).origin
    );
  } catch {
    return false;
  }
}

export function clientIp(request) {
  const platformIp = platformClientIp(request);
  if (platformIp) return platformIp;
  const socketIp = request.socket?.remoteAddress || "unknown";
  const hops = trustedHops();
  if (!hops) return socketIp;
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const chain = [...forwarded, socketIp];
  return chain[Math.max(0, chain.length - hops - 1)] ?? socketIp;
}

const DEFAULT_COUNTRY_HEADER = "CF-IPCountry";

/**
 * The client's country header, as the backend request headers to add.
 *
 * The header is the one `DMS_COUNTRY_HEADER` names (`CF-IPCountry` by
 * default, empty to relay none), the name the DMS reads from
 * `auth.signInCountry.header`. Like `X-Forwarded-For`, it is only believed
 * from a trusted reverse proxy (the platform's client IP header, or
 * `DMS_TRUSTED_PROXY_HOPS` above `0`): otherwise any caller could have set
 * it, so nothing is relayed.
 */
export function clientCountryHeader(request) {
  const name = headerName(
    process.env.DMS_COUNTRY_HEADER ?? DEFAULT_COUNTRY_HEADER,
  );
  if (!name || !isProxyTrusted(request)) return {};
  const value = request.headers?.[name];
  return typeof value === "string" && value.trim()
    ? { [name]: value.trim() }
    : {};
}

/**
 * Body answered with the 403 of the CSRF origin check.
 *
 * The check itself is unchanged: a state-changing request must carry an
 * `Origin` matching the frontend's own. The `reason` only makes the refusal
 * diagnosable, since a bare `{"error":"Forbidden"}` on `POST /auth/login`
 * looks exactly like bad credentials to an API client that simply forgot
 * the header (curl, a server-side integration, a test harness).
 */
export const CROSS_ORIGIN_ERROR = Object.freeze({
  error: "Forbidden",
  reason: "missing or untrusted Origin header",
});
