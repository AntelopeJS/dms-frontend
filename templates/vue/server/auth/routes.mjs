import { createHash } from "node:crypto";
import { backend, body, json, UpstreamError } from "./backend.mjs";
import { isSameOrigin } from "./client-ip.mjs";
import {
  oauthCallback,
  oauthHandoff,
  oauthStart,
  sessionFrom,
} from "./oauth.mjs";
import {
  clearSession,
  persistAccountSession,
  readAccount,
  readSession,
  removeAccount,
  setRequestSession,
} from "./session.mjs";

const REFRESH_TTL_MS = 15_000;
const refreshes = new Map();

const PASSTHROUGH = new Map([
  ["/auth/request-2fa-email", "/api/auth/request-2fa-email"],
]);

export function publicSession(session) {
  if (!session) return {};
  return {
    user: session.user,
    session: {
      accountId: session.accountId,
      activeTenantId: session.activeTenantId,
    },
  };
}

function refreshDigest(token) {
  return createHash("sha256").update(token).digest("base64url");
}

function singleFlight(token, operation) {
  const now = Date.now();
  for (const [key, entry] of refreshes)
    if (
      entry.expiresAt &&
      entry.expiresAt <= now &&
      refreshes.get(key) === entry
    )
      refreshes.delete(key);
  const key = refreshDigest(token);
  const current = refreshes.get(key);
  if (current) return current.promise;
  const entry = { promise: undefined, expiresAt: undefined };
  const promise = Promise.resolve().then(operation);
  entry.promise = promise;
  refreshes.set(key, entry);
  const retain = () => {
    entry.expiresAt = Date.now() + REFRESH_TTL_MS;
    setTimeout(() => {
      if (refreshes.get(key) === entry) refreshes.delete(key);
    }, REFRESH_TTL_MS).unref();
  };
  promise.then(retain, retain);
  return promise;
}

async function establish(request, response, endpoint) {
  const result = await backend(endpoint, request, {
    method: "POST",
    body: await body(request),
  });
  if (result.requires_2fa || result.requires_tenant_assignment)
    return json(response, 200, result);
  const session = sessionFrom(result);
  const account = persistAccountSession(request, response, session);
  json(response, 200, { user: result.user, account });
}

export async function refreshSession(request, response) {
  const session = readSession(request);
  if (!session?.refreshToken) return undefined;
  try {
    const tokens = await singleFlight(session.refreshToken, () =>
      backend("/api/auth/refresh", request, {
        method: "POST",
        token: session.accessToken,
        body: { token: session.refreshToken },
      }),
    );
    const user = await backend("/api/auth/me", request, {
      token: tokens.access_token,
    });
    const refreshed = sessionFrom({ ...tokens, user });
    persistAccountSession(request, response, refreshed, session.accountId);
    setRequestSession(request, refreshed);
    return refreshed;
  } catch (error) {
    const rejected =
      error instanceof UpstreamError && [400, 401, 403].includes(error.status);
    if (rejected) clearSession(response);
    setRequestSession(request, undefined);
    return undefined;
  }
}

async function refresh(request, response) {
  json(response, 200, publicSession(await refreshSession(request, response)));
}

async function logout(request, response) {
  const session = readSession(request);
  if (session?.refreshToken && session?.accessToken)
    await backend("/api/auth/logout", request, {
      method: "POST",
      token: session.accessToken,
      body: { token: session.refreshToken },
    }).catch(() => {});
  clearSession(response);
  if (session?.accountId) removeAccount(request, response, session.accountId);
  json(response, 200, {});
}

async function removeStoredAccount(request, response) {
  const input = await body(request);
  removeAccount(request, response, input.accountId);
  json(response, 200, { success: true });
}

async function switchTenant(request, response) {
  const session = readSession(request);
  const input = await body(request);
  if (!session) return json(response, 401, { message: "Not authenticated" });
  if (!input.tenantId)
    return json(response, 400, { message: "tenantId required" });
  const tokens = await backend("/api/auth/switch-tenant", request, {
    method: "POST",
    token: session.accessToken,
    body: { refreshToken: session.refreshToken, tenantId: input.tenantId },
  });
  const user = await backend("/api/auth/me", request, {
    token: tokens.access_token,
  });
  const switched = sessionFrom({ ...tokens, user });
  persistAccountSession(request, response, switched, session.accountId);
  json(response, 200, { success: true, user });
}

async function switchAccount(request, response) {
  const input = await body(request);
  const account = readAccount(request, input.accountId);
  if (!account) return json(response, 401, { message: "Account expired" });
  try {
    const tokens = await backend("/api/auth/refresh", request, {
      method: "POST",
      body: { token: account.refreshToken },
    });
    const user = await backend("/api/auth/me", request, {
      token: tokens.access_token,
    });
    const session = sessionFrom({ ...tokens, user });
    const descriptor = persistAccountSession(
      request,
      response,
      session,
      input.accountId,
    );
    json(response, 200, { success: true, user, account: descriptor });
  } catch (error) {
    if (
      error instanceof UpstreamError &&
      [400, 401, 403].includes(error.status)
    )
      removeAccount(request, response, input.accountId);
    throw error;
  }
}

async function validateAccount(request, response) {
  const input = await body(request);
  const account = readAccount(request, input.accountId);
  if (!account) return json(response, 200, { valid: false });
  try {
    const tokens = await backend("/api/auth/refresh", request, {
      method: "POST",
      body: { token: account.refreshToken },
    });
    persistAccountSession(
      request,
      response,
      sessionFrom({
        ...tokens,
        user: { id: account.userId, email: account.email, name: account.name },
      }),
      input.accountId,
    );
    json(response, 200, { valid: true });
  } catch (error) {
    const rejected =
      error instanceof UpstreamError && [400, 401, 403].includes(error.status);
    if (rejected) removeAccount(request, response, input.accountId);
    json(response, 200, { valid: rejected ? false : null });
  }
}

const actions = {
  "/auth/login": (request, response) =>
    establish(request, response, "/api/auth/login"),
  "/auth/signup": (request, response) =>
    establish(request, response, "/api/auth/signup"),
  "/auth/verify-2fa": (request, response) =>
    establish(request, response, "/api/auth/verify-2fa"),
  "/auth/switch-account": switchAccount,
  "/auth/switch-tenant": switchTenant,
  "/auth/validate-account": validateAccount,
  "/auth/remove-account": removeStoredAccount,
};

export async function handleAuth(request, response, url) {
  if (url.pathname === "/api/_auth/session") {
    if (request.method === "GET")
      return json(response, 200, publicSession(readSession(request)));
    if (!["POST", "DELETE"].includes(request.method)) {
      response.setHeader("allow", "GET, POST, DELETE");
      return json(response, 405, { error: "Method Not Allowed" });
    }
    if (!isSameOrigin(request))
      return json(response, 403, { error: "Forbidden" });
    return request.method === "DELETE"
      ? logout(request, response)
      : refresh(request, response);
  }
  const match = url.pathname.match(
    /^\/auth\/oauth\/([^/]+)\/(start|callback)$/,
  );
  if (match)
    return match[2] === "start"
      ? oauthStart(request, response, match[1], url)
      : oauthCallback(request, response, match[1], url);
  if (request.method !== "POST" || !isSameOrigin(request))
    return json(response, 403, { error: "Forbidden" });
  if (url.pathname === "/auth/oauth/handoff")
    return oauthHandoff(request, response);
  const endpoint = PASSTHROUGH.get(url.pathname);
  if (endpoint)
    return json(
      response,
      200,
      await backend(endpoint, request, {
        method: "POST",
        body: await body(request),
      }),
    );
  return actions[url.pathname]?.(request, response);
}
