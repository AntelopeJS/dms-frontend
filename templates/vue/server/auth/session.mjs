import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export const SESSION_COOKIE = "dms_session";
const REQUEST_SESSION = Symbol("dms-request-session");
const MAX_AGE = 60 * 60 * 24 * 30;

/**
 * A suffix that keeps this instance's cookies apart from another's on the same
 * host. Browsers scope cookies by hostname, not port: without it, two DMS
 * frontends on localhost:3000 and localhost:3001 would overwrite each other's
 * session, each failing to decrypt the other's and signing the user out. The
 * suffix follows the backend, so a restart keeps the cookies it wrote.
 *
 * A `DMS_API_BASE_URL` that is not a URL is hashed as written: the raw string
 * still tells two backends apart.
 */
function cookieScope() {
  const backendUrl = (process.env.DMS_API_BASE_URL ?? "").trim();
  let canonical = backendUrl;
  try {
    const url = new URL(backendUrl);
    if (url.hostname === "localhost" || url.hostname === "[::1]")
      url.hostname = "127.0.0.1";
    canonical = url.toString().replace(/\/$/, "");
  } catch {}
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** The name `name` takes in this instance's cookie jar. */
export function scopedCookieName(name) {
  return `${name}_${cookieScope()}`;
}

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
  const scoped = scopedCookieName(name);
  const cookies = request.headers.cookie?.split(";") ?? [];
  return cookies
    .map((part) => part.trim().split("="))
    .find(([key]) => key === scoped)?.[1];
}

/**
 * Cookie attributes. Without a `maxAge` the cookie lasts as long as the
 * browser session: it is gone once the browser is closed.
 */
function attributes(maxAge, path = "/") {
  const secure = process.env.DMS_COOKIE_SECURE !== "false" ? "; Secure" : "";
  const lifetime = maxAge === undefined ? "" : `; Max-Age=${maxAge}`;
  return `Path=${path}; HttpOnly; SameSite=Lax${lifetime}${secure}`;
}

/** A session outlives the browser only when it is written `persistent: true`. */
function lifetime(session) {
  return session.persistent === true ? MAX_AGE : undefined;
}

function appendCookie(response, name, value, cookieAttributes) {
  const cookie = `${scopedCookieName(name)}=${value}; ${cookieAttributes}`;
  const current = response.getHeader("set-cookie");
  response.setHeader(
    "set-cookie",
    current
      ? [cookie, ...(Array.isArray(current) ? current : [current])]
      : cookie,
  );
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
    SESSION_COOKIE,
    encode(session),
    attributes(lifetime(session)),
  );
}

export function clearSession(response) {
  appendCookie(response, SESSION_COOKIE, "", attributes(0));
}

export function readSealedCookie(request, name) {
  const value = cookieValue(request, name);
  return value ? decode(value) : undefined;
}

export function writeSealedCookie(response, name, value, maxAge, path = "/") {
  appendCookie(response, name, encode(value), attributes(maxAge, path));
}

export function clearSealedCookie(response, name, path = "/") {
  appendCookie(response, name, "", attributes(0, path));
}
