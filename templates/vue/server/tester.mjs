import { body, json, RequestBodyError } from "./auth/backend.mjs";
import { isSameOrigin } from "./auth/client-ip.mjs";
import { readSession } from "./auth/session.mjs";

const RESPONSE_LIMIT = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const BLOCKED_HEADERS = new Set([
  "host",
  "cookie",
  "cookie2",
  "set-cookie",
  "set-cookie2",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "expect",
  "forwarded",
  "origin",
  "referer",
  "via",
  "authorization",
]);
const CONTROL_HEADER =
  /^(?:sec-|proxy-|x-forwarded-|x-dms-|x-inertia|x-http-method|x-method-override|x-original-|x-rewrite-)/i;
// oxlint-disable-next-line eslint/no-control-regex -- URL paths must reject literal control characters before forwarding.
const UNSAFE_PATH = /[\\#\u0000-\u0020\u007f]/;
// oxlint-disable-next-line eslint/no-control-regex -- Decoded path segments need the same boundary after every decoding pass.
const UNSAFE_DECODED_SEGMENT = /[\\/#\u0000-\u0020\u007f]/;

function invalidInput() {
  throw new RequestBodyError(400, "Invalid tester request");
}

function validatePathSegment(segment) {
  let decoded = segment;
  for (;;) {
    if ([".", ".."].includes(decoded) || UNSAFE_DECODED_SEGMENT.test(decoded))
      return invalidInput();
    let next;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return invalidInput();
    }
    if (next === decoded) break;
    decoded = next;
  }
}

function targetUrl(path) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    UNSAFE_PATH.test(path)
  )
    return invalidInput();
  path.split("?", 1)[0].split("/").forEach(validatePathSegment);
  const base = new URL(process.env.DMS_BACKEND_URL);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password
  )
    throw new Error("Invalid backend configuration");
  const target = new URL(path, base);
  if (target.origin !== base.origin || target.hash) return invalidInput();
  return target;
}

function filteredHeaders(input, allowAuthorization = false) {
  const source = new Headers(input);
  const connection = new Set(
    (source.get("connection") ?? "")
      .toLowerCase()
      .split(",")
      .map((name) => name.trim()),
  );
  return new Headers(
    [...source].filter(
      ([name]) =>
        !connection.has(name) &&
        !CONTROL_HEADER.test(name) &&
        (!BLOCKED_HEADERS.has(name) ||
          (allowAuthorization && name === "authorization")),
    ),
  );
}

function validateInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalidInput();
  if (!METHODS.has(input.method) || typeof input.useSession !== "boolean")
    return invalidInput();
  if (
    !input.headers ||
    typeof input.headers !== "object" ||
    Array.isArray(input.headers)
  )
    return invalidInput();
  if (Object.values(input.headers).some((value) => typeof value !== "string"))
    return invalidInput();
  if (
    input.body !== undefined &&
    (typeof input.body !== "string" || ["GET", "HEAD"].includes(input.method))
  )
    return invalidInput();
  try {
    new Headers(input.headers);
  } catch {
    return invalidInput();
  }
  return targetUrl(input.path);
}

async function limitedText(response) {
  if (!response.body) return "";
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > RESPONSE_LIMIT) throw new Error("Backend response too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function isOwner(session, signal) {
  const response = await fetch(targetUrl("/api/auth/me"), {
    headers: {
      authorization: `Bearer ${session.accessToken}`,
      "x-antelopejs-namespace": "default",
    },
    redirect: "manual",
    signal,
  });
  const text = await limitedText(response);
  if (!response.ok) return false;
  return JSON.parse(text)?.owner === true;
}

function redact(value, session) {
  const secrets = [session.accessToken, session.refreshToken].filter(
    (secret) => typeof secret === "string" && secret.length,
  );
  return secrets.reduce((result, secret) => {
    const variants = [
      secret,
      encodeURIComponent(secret),
      JSON.stringify(secret).slice(1, -1),
    ];
    return variants.reduce(
      (text, variant) => text.replaceAll(variant, "[REDACTED]"),
      result,
    );
  }, value);
}

async function forward(input, target, session, signal) {
  const headers = filteredHeaders(input.headers, true);
  if (input.useSession && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${session.accessToken}`);
    if (!headers.has("x-antelopejs-namespace"))
      headers.set("x-antelopejs-namespace", "default");
  }
  const requestOptions = {
    method: input.method,
    headers,
    redirect: "manual",
    signal,
  };
  if (input.body !== undefined) requestOptions.body = input.body;
  const upstream = await fetch(target, requestOptions);
  const responseHeaders = Object.fromEntries(
    [...filteredHeaders(upstream.headers)].map(([name, value]) => [
      redact(name, session),
      redact(value, session),
    ]),
  );
  return {
    status: upstream.status,
    headers: responseHeaders,
    body: redact(await limitedText(upstream), session),
  };
}

/** Forwards owner-only API tester requests without returning private session credentials. */
export async function handleTester(request, response) {
  response.setHeader("cache-control", "no-store");
  if (request.method !== "POST") {
    response.setHeader("allow", "POST");
    return json(response, 405, { error: "Method Not Allowed" });
  }
  if (!isSameOrigin(request))
    return json(response, 403, { error: "Forbidden" });
  try {
    const session = readSession(request);
    if (!session?.accessToken)
      return json(response, 401, { error: "Not authenticated" });
    const input = await body(request);
    const target = validateInput(input);
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    if (!(await isOwner(session, signal)))
      return json(response, 403, { error: "Forbidden" });
    return json(response, 200, await forward(input, target, session, signal));
  } catch (error) {
    const status = error instanceof RequestBodyError ? error.status : 502;
    return json(response, status, {
      error:
        status === 502 ? "DMS tester request failed" : "Invalid tester request",
    });
  }
}
