/**
 * What the frontend server promises about the backend, as the user docs state
 * it (`docs/7.deployment/3.routing-and-proxy.md`, `4.public-endpoints.md`,
 * `5.security.md`), written apart from the code under test so that the two
 * can disagree. Paths are WHATWG-normalized, the "normalized path" of the
 * docs.
 */

/** @typedef {{ path: string, auth?: string, maxBodyBytes?: number | string }} ProxyEntry */
/** @typedef {{ path: string, methods?: string[], headers?: string[] }} EndpointEntry */
/** @typedef {{ proxies: ProxyEntry[], endpoints: EndpointEntry[] }} Deployment */
/** @typedef {{ path: string, literals: (string | null)[], deep: boolean, auth: "session" | "none" }} Proxy */
/** @typedef {{ path: string, segments: (string | null)[], methods: string[], headers: string[] }} Endpoint */
/**
 * Who answers a visit, and how, as the docs say.
 *
 * @typedef {{
 *   kind: "refused-target" | "renderer" | "backend" | "page" | "not-found",
 *   pathname: string,
 *   search: string,
 *   covering: Proxy[],
 *   winners: Proxy[],
 *   endpoints: Endpoint[],
 * }} Owner
 */

const FRONTEND = "http://frontend.local";
const PROXY_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const ENDPOINT_PATH = /^\/api\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/(?:\*|[A-Za-z0-9][A-Za-z0-9._~-]*))*$/;
const RENDERER_PREFIXES = ["/api/_dms", "/@", "/assets", "/node_modules"];
const ICON_ENDPOINT = "/api/_dms/icons";
const RENDERER_PATHS = ["/@", "/assets/", "/node_modules/", `${ICON_ENDPOINT}/`];
const ENDPOINT_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const OWN_HEADER = /^x-[a-z0-9-]+$/;
const RESERVED_HEADERS = [/^x-forwarded-/, /^x-real-ip$/, /^x-dms-/, /^x-inertia/, /^x-http-method/, /^x-method-override$/, /^x-original-/, /^x-rewrite-/];
const PAGE_METHODS = new Set(["GET", "HEAD"]);

/** The methods a request may use with the session and no Origin. */
export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The backend paths the server reads for a page visit. */
export const PAGE_READS = new Set(["/dms/page", "/dms/sitelayout"]);

/** The visitor's headers every backend request may carry, as received. */
export const RELAYED_HEADERS = new Set(["user-agent", "x-content-language", "x-realtime-session", "x-realtime-connection", "accept", "content-type", "if-match", "origin", "referer"]);

/**
 * The visit's path and query as the server reads them, or `undefined` for a
 * target that is not a path on this server.
 *
 * @param {string} target
 */
function normalizedTarget(target) {
  if (!target.startsWith("/")) return undefined;
  try {
    const url = new URL(target, FRONTEND);
    return url.origin === FRONTEND ? { pathname: url.pathname, search: url.search } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A path's segments, a trailing slash dropped: `/a/b/` names `/a/b`.
 *
 * @param {string} pathname
 */
function pathSegments(pathname) {
  const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return path === "/" ? [] : path.slice(1).split("/");
}

/**
 * Whether `segments` matches `pattern`, where `null` is one non-empty segment.
 *
 * @param {(string | null)[]} pattern
 * @param {boolean} deep Whether the pattern also covers everything below it
 * @param {string[]} segments
 */
function segmentsMatch(pattern, deep, segments) {
  if (deep ? segments.length < pattern.length : segments.length !== pattern.length) return false;
  return pattern.every((literal, index) => (literal === null ? segments[index] !== "" : segments[index] === literal));
}

/**
 * A backend proxy pattern: `/x`, `/x/*` or `/x/**`, literal segments with a
 * `*` or `**` only as the last one, its first segment literal, outside the
 * renderer's own paths.
 *
 * @param {string} pattern
 */
function proxyPattern(pattern) {
  if (!pattern.startsWith("/") || pattern === "/") return undefined;
  const segments = pattern.slice(1).split("/");
  const deep = segments.at(-1) === "**";
  const body = deep ? segments.slice(0, -1) : segments;
  const one = !deep && body.at(-1) === "*";
  const literal = one ? body.slice(0, -1) : body;
  if (literal.length === 0) return undefined;
  const isSegment = (/** @type {string} */ segment) => PROXY_SEGMENT.test(segment) && segment !== "." && segment !== "..";
  if (!literal.every(isSegment)) return undefined;
  const prefix = `/${literal.join("/")}`;
  if (RENDERER_PREFIXES.some((reserved) => prefix === reserved || prefix.startsWith(`${reserved}/`))) return undefined;
  return { literals: one ? [...literal, null] : literal, deep };
}

/**
 * The proxies a deployment declares, malformed ones dropped whole, the first
 * declaration of a pattern kept.
 *
 * @param {ProxyEntry[]} entries
 * @returns {Proxy[]}
 */
export function declaredProxies(entries) {
  /** @type {Map<string, Proxy>} */
  const kept = new Map();
  for (const entry of entries) {
    const parsed = proxyPattern(entry.path);
    const auth = entry.auth ?? "session";
    const limit = entry.maxBodyBytes;
    const isLimit = limit === undefined || (Number.isSafeInteger(limit) && Number(limit) > 0);
    if (!parsed || (auth !== "session" && auth !== "none") || !isLimit) continue;
    if (!kept.has(entry.path)) kept.set(entry.path, { path: entry.path, ...parsed, auth });
  }
  return [...kept.values()];
}

/**
 * The public endpoints a deployment declares, malformed ones dropped whole.
 *
 * @param {EndpointEntry[]} entries
 * @returns {Endpoint[]}
 */
export function declaredEndpoints(entries) {
  return entries.flatMap((entry) => {
    if (!ENDPOINT_PATH.test(entry.path)) return [];
    const methods = entry.methods ?? ["POST"];
    if (methods.length === 0) return [];
    const upper = methods.map((method) => method.toUpperCase());
    const lower = (entry.headers ?? []).map((name) => name.toLowerCase());
    if (!upper.every((method) => ENDPOINT_METHODS.has(method))) return [];
    if (!lower.every((name) => OWN_HEADER.test(name) && !RESERVED_HEADERS.some((reserved) => reserved.test(name)))) return [];
    const segments = entry.path.slice(1).split("/").map((segment) => (segment === "*" ? null : segment));
    return [{ path: entry.path, segments, methods: upper, headers: lower }];
  });
}

/**
 * Whether `proxy` covers `pathname`.
 *
 * @param {Proxy} proxy
 * @param {string} pathname
 */
export function covers(proxy, pathname) {
  return segmentsMatch(proxy.literals, proxy.deep, pathSegments(pathname));
}

/**
 * The public endpoints a request reaches.
 *
 * @param {Endpoint[]} endpoints
 * @param {string} method
 * @param {string} pathname
 */
export function matchingEndpoints(endpoints, method, pathname) {
  return endpoints.filter((endpoint) => endpoint.methods.includes(method) && segmentsMatch(endpoint.segments, false, pathSegments(pathname)));
}

/**
 * Whether `left` is more specific than `right`: more literal segments, then a
 * single-segment `*` over `**`.
 *
 * @param {Proxy} left
 * @param {Proxy} right
 */
function outranks(left, right) {
  const literals = (/** @type {Proxy} */ proxy) => proxy.literals.filter((literal) => literal !== null).length;
  if (literals(left) !== literals(right)) return literals(left) > literals(right);
  return !left.deep && right.deep;
}

/**
 * The covering proxies no other covering proxy outranks: the one that wins,
 * or the tied ones the docs leave to declaration order.
 *
 * @param {Proxy[]} covering
 */
function mostSpecific(covering) {
  return covering.filter((candidate) => !covering.some((other) => outranks(other, candidate)));
}

/**
 * Whether `pathname` is the renderer's own: Vite's URLs, the built assets,
 * the icon endpoint.
 *
 * @param {string} pathname
 */
function isRendererPath(pathname) {
  return pathname === ICON_ENDPOINT || RENDERER_PATHS.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Who answers a visit, per "Who answers a path": the renderer, then the
 * backend proxies, then the pages. The harness declares no module route.
 *
 * @param {Deployment} deployment
 * @param {string} method
 * @param {string} target
 * @returns {Owner}
 */
export function ownerOf(deployment, method, target) {
  const normalized = normalizedTarget(target);
  const empty = { covering: [], winners: [], endpoints: [] };
  if (!normalized) return { kind: "refused-target", pathname: "", search: "", ...empty };
  const { pathname, search } = normalized;
  if (isRendererPath(pathname)) return { kind: "renderer", pathname, search, ...empty };
  const covering = declaredProxies(deployment.proxies).filter((proxy) => covers(proxy, pathname));
  if (covering.length === 0) return { kind: PAGE_METHODS.has(method) ? "page" : "not-found", pathname, search, ...empty };
  const endpoints = matchingEndpoints(declaredEndpoints(deployment.endpoints), method, pathname);
  return { kind: "backend", pathname, search, covering, winners: mostSpecific(covering), endpoints };
}

/**
 * Whether `origin` is the frontend's own for a request sent to `host`.
 *
 * @param {string | undefined} origin
 * @param {string} host
 */
export function isOwnOrigin(origin, host) {
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(`http://${host}`).origin;
  } catch {
    return false;
  }
}
