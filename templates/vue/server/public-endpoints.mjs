import { readFileSync } from "node:fs";
import { json } from "./auth/backend.mjs";
import { CROSS_ORIGIN_ERROR, isSameOrigin } from "./auth/client-ip.mjs";
import { isNonNullObject, isString } from "./type-guards.mjs";

/**
 * A public endpoint, compiled from a declaration that passed every check.
 *
 * @typedef {object} PublicEndpoint
 * @property {string} path
 * @property {string[]} methods
 * @property {string[]} headers
 * @property {RegExp} matcher
 */

/**
 * A declaration as the manifest or the environment holds it, before any check.
 *
 * @typedef {object} PublicEndpointDeclaration
 * @property {unknown} [path]
 * @property {unknown} [methods]
 * @property {unknown} [headers]
 */

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

/** @type {unknown[] | undefined} */
let declaredEndpoints;
/** @type {import("./backend-proxies.mjs").ManifestProxy[] | undefined} */
let declaredProxies;

/**
 * The public endpoints the modules of this deployment declared, unchecked.
 *
 * @param {URL | string} [file] Generated file to read
 * @returns {unknown[]} The declared entries, or none when the file is absent or broken
 */
export function readDeclaredPublicEndpoints(file = DECLARED_ENDPOINTS_FILE) {
  try {
    /** @type {unknown} */
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
 * @param {URL | string} [file] Generated file to read
 * @returns {import("./backend-proxies.mjs").ManifestProxy[]}
 */
export function readDeclaredBackendProxies(file = DECLARED_ENDPOINTS_FILE) {
  if (file === DECLARED_ENDPOINTS_FILE && declaredProxies)
    return declaredProxies;
  /** @type {import("./backend-proxies.mjs").ManifestProxy[]} */
  let proxies = [];
  try {
    /** @type {unknown} */
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
 * @param {string} [declaration] The variable's value
 * @returns {import("./backend-proxies.mjs").ManifestProxy[]}
 */
export function environmentBackendProxies(
  declaration = process.env.DMS_BACKEND_PROXIES,
) {
  if (!declaration?.trim()) return [];
  try {
    /** @type {unknown} */
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

/**
 * @param {string | undefined} declaration
 * @returns {unknown[]}
 */
function environmentEndpoints(declaration) {
  if (!declaration?.trim()) return [];
  try {
    /** @type {unknown} */
    const parsed = JSON.parse(declaration);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    console.warn("Ignoring DMS_PUBLIC_ENDPOINTS: not a JSON array");
    return [];
  }
}

/** @param {unknown} methods */
function normalizedMethods(methods) {
  if (methods === undefined) return DEFAULT_METHODS;
  if (!Array.isArray(methods) || methods.length === 0) return undefined;
  const upper = methods.map((method) => String(method).toUpperCase());
  return upper.every((method) => ALLOWED_METHODS.has(method))
    ? upper
    : undefined;
}

/** @param {unknown} headers */
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

/** @param {string} path */
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
 *
 * @param {PublicEndpointDeclaration | null | undefined} entry
 * @returns {PublicEndpoint | undefined}
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
 *
 * @param {string} [declaration]
 * @param {unknown[]} [declared]
 * @returns {PublicEndpoint[]}
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
 *
 * @type {{ declaration: string | undefined, endpoints: PublicEndpoint[] } | undefined}
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
 * @param {string} method The request's method
 * @param {string} pathname The request's normalized path, without its query string
 * @param {PublicEndpoint[]} [endpoints] The endpoints to match, this deployment's by default
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
 * @param {import("node:http").IncomingMessage} request The incoming request
 * @param {ReadonlySet<string>} safeMethods Methods that change nothing and need no Origin
 * @param {import("./backend-proxies.mjs").BackendProxy} proxy The backend proxy the request reached
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

/**
 * Answers the 403 of a request `proxyAccess` refused.
 *
 * @param {import("node:http").ServerResponse} response
 */
export function refuseCrossOrigin(response) {
  json(response, 403, CROSS_ORIGIN_ERROR);
}
