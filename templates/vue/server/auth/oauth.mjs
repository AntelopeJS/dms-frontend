import { timingSafeEqual } from "node:crypto";
import { backend, json } from "./backend.mjs";
import { clientIp } from "./client-ip.mjs";
import {
  clearSealedCookie,
  persistAccountSession,
  readSealedCookie,
  writeSealedCookie,
} from "./session.mjs";

const FLOW = "dms_oauth_flow";
const HANDOFF = "dms_oauth_handoff";
const COMPLETE = "/auth/oauth/complete";
const FLOW_LIFETIME_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = 10;
const MAX_RATE_LIMIT_CLIENTS = 10_000;
const MAX_CALLBACK_PARAMETER_LENGTH = 2048;
const attempts = new Map();

export function resolveOAuthClientKey(request) {
  return clientIp(request);
}

function sweepAttempts(now) {
  for (const [key, window] of attempts) {
    if (now - window.startedAt >= RATE_WINDOW_MS) attempts.delete(key);
  }
  while (attempts.size >= MAX_RATE_LIMIT_CLIENTS)
    attempts.delete(attempts.keys().next().value);
}

export function hitOAuthRateLimitKey(key, now = Date.now()) {
  sweepAttempts(now);
  const window = attempts.get(key);
  if (!window || now - window.startedAt >= RATE_WINDOW_MS) {
    attempts.set(key, { count: 1, startedAt: now });
    return true;
  }
  window.count += 1;
  return window.count <= RATE_LIMIT;
}

function rateLimited(request, scope) {
  const now = Date.now();
  return !hitOAuthRateLimitKey(
    `${scope}:${resolveOAuthClientKey(request)}`,
    now,
  );
}

export function isValidOAuthProvider(provider) {
  return typeof provider === "string" && /^[a-z0-9-]{1,32}$/.test(provider);
}

function safePath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return "";
  try {
    const decoded = decodeURIComponent(value);
    return decoded.startsWith("//") || decoded.includes("\\") ? "" : value;
  } catch {
    return "";
  }
}

function redirect(response, location) {
  response.writeHead(302, { location });
  response.end();
}

function errorRedirect(response, key) {
  redirect(response, `/auth?oauth_error=${encodeURIComponent(key)}`);
}

export async function oauthStart(request, response, provider, url) {
  if (
    !isValidOAuthProvider(provider) ||
    request.headers["sec-fetch-site"] === "cross-site" ||
    rateLimited(request, "start")
  )
    return errorRedirect(response, "error.oauth.failed");
  try {
    const result = await backend(
      `/api/auth/oauth/${provider}/authorize-url`,
      request,
      { relay: true },
    );
    writeSealedCookie(
      response,
      FLOW,
      {
        state: result.state,
        expiresAt: Date.now() + FLOW_LIFETIME_MS,
        redirect: safePath(url.searchParams.get("redirect")),
        language: url.searchParams.get("language") ?? "",
        invite: url.searchParams.get("invite") ?? "",
      },
      FLOW_LIFETIME_MS / 1000,
    );
    redirect(response, result.authorizeUrl);
  } catch {
    errorRedirect(response, "error.oauth.failed");
  }
}

function sameState(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function validCallback(flow, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  return !(
    !flow ||
    flow.expiresAt < Date.now() ||
    typeof code !== "string" ||
    code.length > MAX_CALLBACK_PARAMETER_LENGTH ||
    typeof state !== "string" ||
    state.length > MAX_CALLBACK_PARAMETER_LENGTH ||
    !sameState(state, flow.state)
  );
}

function storeOAuthResult(request, response, provider, result) {
  if (result.requires_2fa)
    writeSealedCookie(
      response,
      HANDOFF,
      { kind: "2fa", token: result.two_factor_token, methods: result.methods },
      300,
    );
  else if (result.requires_tenant_assignment)
    writeSealedCookie(
      response,
      HANDOFF,
      { kind: "no-workspace", token: result.tenant_assignment_token, provider },
      300,
    );
  else persistAccountSession(request, response, sessionFrom(result));
}

async function completeOAuth(request, response, provider, url, flow) {
  try {
    const result = await backend(
      `/api/auth/oauth/${provider}/callback`,
      request,
      {
        method: "POST",
        relay: true,
        body: {
          code: url.searchParams.get("code"),
          state: url.searchParams.get("state"),
          state_cookie: flow.state,
          language: flow.language || undefined,
          invite: flow.invite || undefined,
        },
      },
    );
    storeOAuthResult(request, response, provider, result);
    redirect(
      response,
      flow.redirect &&
        !result.requires_2fa &&
        !result.requires_tenant_assignment
        ? `${COMPLETE}?redirect=${encodeURIComponent(flow.redirect)}`
        : COMPLETE,
    );
  } catch {
    errorRedirect(response, "error.oauth.failed");
  }
}

export async function oauthCallback(request, response, provider, url) {
  if (!isValidOAuthProvider(provider) || rateLimited(request, "callback"))
    return errorRedirect(response, "error.oauth.failed");
  const flow = readSealedCookie(request, FLOW);
  clearSealedCookie(response, FLOW);
  if (url.searchParams.has("error"))
    return errorRedirect(response, "error.oauth.cancelled");
  if (!validCallback(flow, url))
    return errorRedirect(response, "error.oauth.invalid_state");
  return completeOAuth(request, response, provider, url, flow);
}

export function oauthHandoff(request, response) {
  const handoff = readSealedCookie(request, HANDOFF) ?? { kind: "none" };
  clearSealedCookie(response, HANDOFF);
  json(response, 200, handoff);
}

export function sessionFrom(result) {
  const payload = JSON.parse(
    Buffer.from(
      result.access_token.split(".")[1] ?? "",
      "base64url",
    ).toString() || "{}",
  );
  return {
    user: result.user,
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    activeTenantId: payload.tenantId ?? "default",
  };
}
