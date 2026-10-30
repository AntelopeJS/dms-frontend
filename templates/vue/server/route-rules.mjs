import { compilePathPattern } from "./path-patterns.mjs";
import { isNonNullObject, isObjectLike, isString } from "./type-guards.mjs";

/** @typedef {import("../server-module.ts").DmsRouteRule} RouteRule */
/** @typedef {RouteRule & { headers: Record<string, string> }} MergedRouteRule */
/**
 * @typedef {object} ResolvedRouteRule
 * @property {string} id The declaring module
 * @property {number} priority The declaring module's priority
 * @property {import("./path-patterns.mjs").CompiledPathPattern} pattern
 * @property {RouteRule} rule
 */

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
/**
 * Whether a header value holds a control character other than a tab: a CR
 * or an LF would split the answer.
 *
 * @param {string} value
 */
function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return (code < 0x20 && code !== 0x09) || code === 0x7f;
  });
}
/** Set by the server itself: a rule's `cache` decides `cache-control`. */
const RESERVED_HEADERS = new Set([
  "cache-control",
  "set-cookie",
  "vary",
  "content-type",
  "content-length",
  "x-inertia",
  "x-inertia-version",
]);

/** @param {unknown} value */
function isSeconds(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** @param {unknown} headers */
function headersRejection(headers) {
  if (headers === undefined) return undefined;
  if (!isNonNullObject(headers) || Array.isArray(headers))
    return "headers is not an object";
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      !HEADER_NAME.test(lower) ||
      !isString(value) ||
      hasControlCharacter(value)
    )
      return `"${name}" is not a header with a text value`;
    if (RESERVED_HEADERS.has(lower))
      return `the server sets "${name}" itself (use cache for cache-control)`;
  }
  return undefined;
}

/** @param {unknown} cache */
function cacheRejection(cache) {
  if (cache === undefined || cache === false) return undefined;
  if (
    !isNonNullObject(cache) ||
    cache.public !== true ||
    !isSeconds(cache.maxAge) ||
    (cache.staleWhileRevalidate !== undefined &&
      !isSeconds(cache.staleWhileRevalidate))
  )
    return "cache is neither false nor { public: true, maxAge, staleWhileRevalidate? } in seconds";
  return undefined;
}

/**
 * Why a rule is ignored, or `undefined`.
 *
 * Route rules the modules declare in their `dms.server.ts`: how a page is
 * rendered and which headers its document and Inertia answers carry. They
 * change rendering and caching, never who may see a page.
 *
 * @param {string} pattern
 * @param {unknown} rule
 */
export function ruleRejection(pattern, rule) {
  if (!compilePathPattern(pattern))
    return "the pattern is not /x, /x/* or /x/**";
  if (!isNonNullObject(rule)) return "it is not an object";
  if (rule.ssr !== undefined && rule.ssr !== false)
    return "ssr is either left out or false";
  return headersRejection(rule.headers) ?? cacheRejection(rule.cache);
}

/**
 * The rules that apply to `pathname`, merged from the least to the most
 * specific pattern: a more specific rule overrides `ssr`, `cache` and each
 * header it sets.
 *
 * @param {readonly ResolvedRouteRule[]} rules The resolved rules, `{ pattern, rule }` each
 * @param {string} pathname The page's path
 * @returns {MergedRouteRule}
 */
export function routeRuleFor(rules, pathname) {
  /** @type {MergedRouteRule} */
  const merged = { headers: {} };
  const matching = rules
    .filter(({ pattern }) => pattern.test(pathname))
    .sort(
      (left, right) => left.pattern.specificity - right.pattern.specificity,
    );
  for (const { rule } of matching) {
    if (rule.ssr !== undefined) merged.ssr = rule.ssr;
    if (rule.cache !== undefined) merged.cache = rule.cache;
    Object.assign(merged.headers, rule.headers);
  }
  return merged;
}

/** @param {{ maxAge: number, staleWhileRevalidate?: number }} cache */
function publicCacheControl(cache) {
  const stale =
    cache.staleWhileRevalidate === undefined
      ? ""
      : `, stale-while-revalidate=${cache.staleWhileRevalidate}`;
  return `public, max-age=${cache.maxAge}${stale}`;
}

/**
 * The headers a page answer adds for its rule. A public `cache` only applies
 * to a page the backend serves to anyone, asked without any cookie or
 * content language: the answer then holds nobody's data, and `Vary: Cookie`
 * keeps a shared cache from serving it to a visitor who has some.
 *
 * @param {MergedRouteRule} rule What `routeRuleFor` returned
 * @param {import("node:http").IncomingMessage} request The page request
 * @param {unknown} route The page's route, as the backend described it: any JSON value, only `publicAccess` is read
 * @param {number} status The answer's status: only a 200 is cached
 */
export function ruleHeaders(rule, request, route, status) {
  const headers = { ...rule.headers };
  if (
    rule.cache &&
    status === 200 &&
    request.method === "GET" &&
    !request.headers.cookie &&
    !request.headers["x-content-language"] &&
    isObjectLike(route) &&
    route.publicAccess === true
  ) {
    headers["cache-control"] = publicCacheControl(rule.cache);
    headers.vary = "X-Inertia, Cookie";
  }
  return headers;
}
