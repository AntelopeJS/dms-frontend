function trustedHops() {
  const value = Number.parseInt(process.env.DMS_TRUSTED_PROXY_HOPS ?? "0", 10);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function requestScheme(request) {
  if (trustedHops()) {
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
  if (!trustedHops()) return request.headers.host;
  return (
    String(request.headers["x-forwarded-host"] ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .at(-1) || request.headers.host
  );
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
