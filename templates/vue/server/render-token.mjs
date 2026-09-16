// Verification for the service token that guards the HTML render route.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows, and so the three concerns the check actually has -- signature,
// claims, replay -- are named rather than run together in one function.

import { createHmac, timingSafeEqual } from "node:crypto";

const RENDER_TOKEN_LIFETIME_SECONDS = 5 * 60;
const RENDER_REPLAY_LIMIT = 10_000;

/** jti -> exp, for tokens already spent. Pruned on every accepted token. */
const usedRenderTokens = new Map();

/**
 * Constant-time check of the token's HMAC. The length comparison guards
 * timingSafeEqual, which throws on mismatched lengths -- it is not itself a
 * timing leak, since the length of a base64url HMAC is fixed.
 */
function signatureValid(parts, secret) {
  const expected = createHmac("sha256", secret)
    .update(`${parts[0]}.${parts[1]}`)
    .digest("base64url");
  if (expected.length !== parts[2].length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]));
}

/**
 * The claims this service will accept. `exp - iat` is bounded so a token
 * minted with a far-future expiry cannot outlive the intended window.
 */
function claimsValid(payload, now) {
  return (
    payload.namespace === "html-render-service" &&
    payload.purpose === "html-render" &&
    payload.aud === "dms-frontend" &&
    typeof payload.jti === "string" &&
    payload.jti.length >= 16 &&
    Number.isSafeInteger(payload.iat) &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp > now &&
    payload.exp - payload.iat <= RENDER_TOKEN_LIFETIME_SECONDS &&
    payload.iat <= now
  );
}

/**
 * Records a token as spent, dropping expired entries first and evicting the
 * oldest if the map is at its cap, so a flood of tokens cannot grow it without
 * bound.
 */
function rememberToken(payload, now) {
  for (const [jti, expiresAt] of usedRenderTokens)
    if (expiresAt <= now) usedRenderTokens.delete(jti);
  while (usedRenderTokens.size >= RENDER_REPLAY_LIMIT)
    usedRenderTokens.delete(usedRenderTokens.keys().next().value);
  usedRenderTokens.set(payload.jti, payload.exp);
}

/**
 * @param {string | undefined} token the x-dms-service-token header
 * @returns {boolean} whether the token is well-formed, signed, unexpired and
 *   not already spent. A token accepted here is immediately marked as spent.
 */
export function validRenderToken(token) {
  const secret = process.env.DMS_HTML_RENDER_SECRET;
  if (!token || !secret) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  if (!signatureValid(parts, secret)) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url"));
    const now = Math.floor(Date.now() / 1000);
    if (!claimsValid(payload, now)) return false;
    if (usedRenderTokens.has(payload.jti)) return false;
    rememberToken(payload, now);
    return true;
  } catch {
    return false;
  }
}
