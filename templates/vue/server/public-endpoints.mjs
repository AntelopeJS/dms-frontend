import { readFileSync } from "node:fs";
import { json } from "./auth/backend.mjs";
import { CROSS_ORIGIN_ERROR, isSameOrigin } from "./auth/client-ip.mjs";
import { isNonNullObject, isString } from "./type-guards.mjs";

/**
 * Written at the workspace root by the loader, from the endpoints each
 * backend module declared in the frontend manifest. This file sits one
 * directory up.
 */
const DECLARED_ENDPOINTS_FILE = new URL(
  "../generated-public-endpoints.json",
  import.meta.url,
);

/**
 * An absolute backend API path whose first segment is literal (a `*` there
 * would open a route of every module) and whose next ones are literal or `*`
 * (exactly one segment): no prefix match, no query string, no segment that
 * climbs out. Kept in step with `PUBLIC_PATH` in the DMS
 * (`frontend-public-endpoints.ts`), which validates the modules' declarations.
 */
const PUBLIC_PATH =
  /^\/api\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/(?:\*|[A-Za-z0-9][A-Za-z0-9._~-]*))*$/;
const SEGMENT_WILDCARD = "*";
const SEGMENT_PATTERN = "[^/]+";
const ALLOWED_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const DEFAULT_METHODS = ["POST"];
/**
 * A declared header is a module's own `x-` header. Those the proxy, a
 * reverse proxy or the backend give a meaning to are never taken from the
 * caller. Kept in step with the DMS's `RESERVED_HEADER`.
 */
const HEADER_NAME = /^x-[a-z0-9-]+$/;
const RESERVED_HEADER =
  /^x-(?:forwarded-|real-ip$|dms-|inertia|http-method|method-override|original-|rewrite-)/;

let declaredEndpoints;
let declaredProxies;

/**
 * The public endpoints the modules of this deployment declared, unchecked.
 *
 * @param file Generated file to read
 * @returns The declared entries, or none when the file is absent or broken
 */
export function readDeclaredPublicEndpoints(file = DECLARED_ENDPOINTS_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(parsed?.endpoints) ? parsed.endpoints : [];
  } catch {
    return [];
  }
}

/**
 * The backend proxies the backend modules declared in the manifest, as
 * `{ module, path, auth?, maxBodyBytes? }`, unchecked.
 *
 * A missing or broken file declares no proxy.
 *
 * @param file Generated file to read
 */
export function readDeclaredBackendProxies(file = DECLARED_ENDPOINTS_FILE) {
  if (file === DECLARED_ENDPOINTS_FILE && declaredProxies)
    return declaredProxies;
  let proxies = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed?.proxies)) proxies = parsed.proxies;
  } catch {}
  if (file === DECLARED_ENDPOINTS_FILE) declaredProxies = proxies;
  return proxies;
}

/**
 * The backend proxies `DMS_BACKEND_PROXIES` adds: a JSON array of
 * `{ path, auth?, maxBodyBytes? }`, as the manifest's `backendProxies`, for an
 * operator. A value that is not a JSON array is reported and ignored.
 *
 * @param declaration The variable's value
 */
export function environmentBackendProxies(
  declaration = process.env.DMS_BACKEND_PROXIES,
) {
  if (!declaration?.trim()) return [];
  try {
    const parsed = JSON.parse(declaration);
    if (Array.isArray(parsed))
      return parsed.map((entry) => ({
        ...entry,
        module: "DMS_BACKEND_PROXIES",
      }));
  } catch {}
  console.warn("Ignoring DMS_BACKEND_PROXIES: not a JSON array");
  return [];
}

function environmentEndpoints(declaration) {
  if (!declaration?.trim()) return [];
  try {
    const parsed = JSON.parse(declaration);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("Ignoring DMS_PUBLIC_ENDPOINTS: not a JSON array");
    return [];
  }
}

function normalizedMethods(methods) {
  if (methods === undefined) return DEFAULT_METHODS;
  if (!Array.isArray(methods) || methods.length === 0) return undefined;
  const upper = methods.map((method) => String(method).toUpperCase());
  return upper.every((method) => ALLOWED_METHODS.has(method))
    ? upper
    : undefined;
}

function normalizedHeaders(headers) {
  if (headers === undefined) return [];
  if (!Array.isArray(headers)) return undefined;
  const lower = headers.map((name) => String(name).toLowerCase());
  return lower.every(
    (name) => HEADER_NAME.test(name) && !RESERVED_HEADER.test(name),
  )
    ? lower
    : undefined;
}

function pathMatcher(path) {
  const pattern = path
    .split("/")
    .map((segment) =>
      segment === SEGMENT_WILDCARD
        ? SEGMENT_PATTERN
        : segment.replaceAll(".", "\\."),
    )
    .join("/");
  return new RegExp(`^${pattern}/?$`);
}

/**
 * A declaration made usable, or `undefined` when any part of it is malformed:
 * a bad entry is dropped whole, never widened to what it might have meant.
 */
export function compilePublicEndpoint(entry) {
  if (!isNonNullObject(entry)) return undefined;
  if (!isString(entry.path) || !PUBLIC_PATH.test(entry.path)) return undefined;
  const methods = normalizedMethods(entry.methods);
  const headers = normalizedHeaders(entry.headers);
  if (!methods || !headers) return undefined;
  return {
    path: entry.path,
    methods,
    headers,
    matcher: pathMatcher(entry.path),
  };
}

/**
 * The backend endpoints this deployment serves to anyone: what the backend's
 * modules declared, plus what `DMS_PUBLIC_ENDPOINTS` adds (a JSON array of the
 * same `{ path, methods?, headers? }` entries).
 */
export function allowedPublicEndpoints(
  declaration = process.env.DMS_PUBLIC_ENDPOINTS,
  declared = (declaredEndpoints ??= readDeclaredPublicEndpoints()),
) {
  return [...declared, ...environmentEndpoints(declaration)].flatMap(
    (entry) => {
      const endpoint = compilePublicEndpoint(entry);
      if (!endpoint)
        console.warn(
          `Ignoring malformed public endpoint ${JSON.stringify(entry)}: expected ` +
            '{ path: "/api/<prefix>/…" (segments or *), methods?: ["POST"], headers?: ["x-…"] }',
        );
      return endpoint ? [endpoint] : [];
    },
  );
}

/**
 * Compiled once per value of the environment variable, so a malformed entry
 * is reported once rather than on every request.
 */
let compiled;

function currentPublicEndpoints() {
  const declaration = process.env.DMS_PUBLIC_ENDPOINTS;
  if (!compiled || compiled.declaration !== declaration)
    compiled = { declaration, endpoints: allowedPublicEndpoints(declaration) };
  return compiled.endpoints;
}

/**
 * The public endpoint a request reaches, if any.
 *
 * @param method The request's method
 * @param pathname The request's normalized path, without its query string
 * @param endpoints The endpoints to match, this deployment's by default
 */
export function matchPublicEndpoint(
  method,
  pathname,
  endpoints = currentPublicEndpoints(),
) {
  return endpoints.find(
    (endpoint) =>
      endpoint.methods.includes(method) && endpoint.matcher.test(pathname),
  );
}

/**
 * How the proxy treats a request to a backend proxy: whether it sends the
 * session, the extra headers it relays, and whether it refuses the request
 * for lacking a same-site Origin.
 *
 * A proxy with `auth: "none"` never sends the session, so it needs no
 * Origin. Under `auth: "session"`, a state-changing request needs one unless
 * it reaches a public endpoint, which is why the proxy never sends a public
 * endpoint the session: a cross-site form posting to it acts as nobody.
 *
 * @param request The incoming request
 * @param safeMethods Methods that change nothing and need no Origin
 * @param proxy The backend proxy the request reached
 * @returns `{ anonymous, headers, isRefused }`
 */
export function proxyAccess(request, safeMethods, proxy) {
  if (proxy.auth === "none")
    return { anonymous: true, headers: [], isRefused: false };
  const publicEndpoint = matchPublicEndpoint(
    request.method,
    new URL(request.url, "http://frontend.local").pathname,
  );
  if (publicEndpoint)
    return {
      anonymous: true,
      headers: publicEndpoint.headers,
      isRefused: false,
    };
  return {
    anonymous: false,
    headers: [],
    isRefused: !safeMethods.has(request.method) && !isSameOrigin(request),
  };
}

/** Answers the 403 of a request `proxyAccess` refused. */
export function refuseCrossOrigin(response) {
  json(response, 403, CROSS_ORIGIN_ERROR);
}
