import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";

const SESSION_COOKIE = "dms_session";
const ACCOUNT_INDEX_COOKIE = "dms_account_index";
const ACCOUNT_COOKIE_PREFIX = "dms_account_";
const REQUEST_SESSION = Symbol("dms-request-session");
const MAX_AGE = 60 * 60 * 24 * 30;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function key() {
  const secret = process.env.DMS_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error(
      "DMS_SESSION_SECRET must contain at least 32 characters; " +
        "generate one with: openssl rand -hex 32",
    );
  return createHash("sha256").update(secret).digest();
}

function encode(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}

function decode(value) {
  try {
    const payload = Buffer.from(value, "base64url");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      payload.subarray(0, 12),
    );
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]),
    );
  } catch {
    return undefined;
  }
}

function cookieValue(request, name) {
  const cookies = request.headers.cookie?.split(";") ?? [];
  return cookies
    .map((part) => part.trim().split("="))
    .find(([key]) => key === name)?.[1];
}

function attributes(maxAge, path = "/") {
  const secure = process.env.DMS_COOKIE_SECURE !== "false" ? "; Secure" : "";
  return `Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function appendCookie(response, cookie) {
  const current = response.getHeader("set-cookie");
  response.setHeader(
    "set-cookie",
    current
      ? [cookie, ...(Array.isArray(current) ? current : [current])]
      : cookie,
  );
}

function accountCookieName(accountId) {
  if (!UUID.test(accountId)) throw new Error("Invalid account id");
  return `${ACCOUNT_COOKIE_PREFIX}${accountId.replaceAll("-", "")}`;
}

function descriptor(session, accountId) {
  return {
    accountId,
    userId: session.user?._id ?? session.user?.id,
    email: session.user?.email,
    name: session.user?.name,
    activeTenantId: session.activeTenantId,
  };
}

export function readSession(request) {
  if (REQUEST_SESSION in request) return request[REQUEST_SESSION];
  const value = cookieValue(request, SESSION_COOKIE);
  return value ? decode(value) : undefined;
}

export function setRequestSession(request, session) {
  request[REQUEST_SESSION] = session;
}

export function writeSession(response, session) {
  appendCookie(
    response,
    `${SESSION_COOKIE}=${encode(session)}; ${attributes(MAX_AGE)}`,
  );
}

export function clearSession(response) {
  appendCookie(response, `${SESSION_COOKIE}=; ${attributes(0)}`);
}

export function readAccounts(request) {
  const value = cookieValue(request, ACCOUNT_INDEX_COOKIE);
  return value ? (decode(value) ?? {}) : {};
}

function writeAccountIndex(response, accounts) {
  appendCookie(
    response,
    `${ACCOUNT_INDEX_COOKIE}=${encode(accounts)}; ${attributes(MAX_AGE)}`,
  );
}

export function readAccount(request, accountId) {
  if (!UUID.test(accountId ?? "")) return undefined;
  const value = cookieValue(request, accountCookieName(accountId));
  return value ? decode(value) : undefined;
}

export function storeAccount(request, response, session, accountId) {
  const id = accountId ?? randomUUID();
  const accountDescriptor = descriptor(session, id);
  const accounts = { ...readAccounts(request), [id]: accountDescriptor };
  writeAccountIndex(response, accounts);
  appendCookie(
    response,
    `${accountCookieName(id)}=${encode({ refreshToken: session.refreshToken, ...accountDescriptor })}; ${attributes(MAX_AGE)}`,
  );
  return accountDescriptor;
}

export function assertAccountInvariant(session, accountId) {
  if (!accountId || session.accountId !== accountId)
    throw new Error("Account session invariant violated");
}

export function persistAccountSession(request, response, session, accountId) {
  const id = accountId ?? session.accountId ?? randomUUID();
  session.accountId = id;
  const account = storeAccount(request, response, session, id);
  assertAccountInvariant(session, account.accountId);
  writeSession(response, session);
  return account;
}

export function removeAccount(request, response, accountId) {
  const accounts = { ...readAccounts(request) };
  delete accounts[accountId];
  writeAccountIndex(response, accounts);
  if (UUID.test(accountId ?? ""))
    appendCookie(
      response,
      `${accountCookieName(accountId)}=; ${attributes(0)}`,
    );
}

export function readSealedCookie(request, name) {
  const value = cookieValue(request, name);
  return value ? decode(value) : undefined;
}

export function writeSealedCookie(response, name, value, maxAge) {
  appendCookie(
    response,
    `${name}=${encode(value)}; ${attributes(maxAge, "/auth/oauth")}`,
  );
}

export function clearSealedCookie(response, name) {
  appendCookie(response, `${name}=; ${attributes(0, "/auth/oauth")}`);
}
