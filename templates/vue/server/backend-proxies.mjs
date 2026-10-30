import { compilePathPattern } from "./path-patterns.mjs";

/** @typedef {import("../server-module.ts").DmsBackendProxyOptions} ProxyOptions */
/**
 * A backend prefix the server proxies, compiled from a pattern `proxyRejection`
 * accepted.
 *
 * @typedef {object} BackendProxy
 * @property {import("./path-patterns.mjs").CompiledPathPattern} pattern
 * @property {string} path The pattern as declared
 * @property {string} owner Who declared it
 * @property {NonNullable<ProxyOptions["auth"]>} auth
 * @property {number} [maxBodyBytes]
 */
/**
 * What `registerBackendProxy` declared, per call.
 *
 * @typedef {object} ProxyDeclaration
 * @property {string} id The declaring frontend module
 * @property {string} pattern
 * @property {ProxyOptions} [options]
 */
/**
 * What a backend module declared in the manifest, or an operator in
 * `DMS_BACKEND_PROXIES`.
 *
 * @typedef {object} ManifestProxy
 * @property {string} [module]
 * @property {string} [path]
 * @property {ProxyOptions["auth"]} [auth]
 * @property {number} [maxBodyBytes]
 */

/** How the proxy authenticates a request to the backend. */
export const PROXY_AUTH_MODES = Object.freeze(["session", "none"]);
const DEFAULT_AUTH = "session";
/** The renderer's own paths, never a backend's. */
const RENDERER_PREFIXES = ["/api/_dms", "/@", "/assets", "/node_modules"];

/** @param {string} pattern */
function literalPrefix(pattern) {
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
  /** @type {string[]} */
  const literal = [];
  for (const segment of segments) {
    if (segment === "*" || segment === "**") break;
    literal.push(segment);
  }
  return `/${literal.join("/")}`;
}

/**
 * Why a proxy declaration is ignored, or `undefined`.
 *
 * @param {string} pattern
 * @param {ProxyOptions | undefined} options
 */
export function proxyRejection(pattern, options) {
  const compiled = compilePathPattern(pattern);
  if (!compiled) return "the pattern is not /x, /x/* or /x/**";
  const prefix = literalPrefix(pattern);
  if (prefix === "/")
    return "its first segment is not literal: it would take every page";
  if (
    RENDERER_PREFIXES.some(
      (reserved) => prefix === reserved || prefix.startsWith(`${reserved}/`),
    )
  )
    return `${RENDERER_PREFIXES.join(", ")} are the renderer's own paths`;
  if (options !== undefined && (typeof options !== "object" || !options))
    return "its options are not an object";
  if (options?.auth !== undefined && !PROXY_AUTH_MODES.includes(options.auth))
    return `auth is not one of ${PROXY_AUTH_MODES.map((mode) => `"${mode}"`).join(", ")}`;
  if (
    options?.maxBodyBytes !== undefined &&
    !(Number.isSafeInteger(options.maxBodyBytes) && options.maxBodyBytes > 0)
  )
    return "maxBodyBytes is not a positive whole number of bytes";
  return undefined;
}

/**
 * @param {string} pattern A pattern `proxyRejection` accepted
 * @param {ProxyOptions | undefined} options
 * @param {string} owner Who declared it
 * @returns {BackendProxy}
 */
function compileProxy(pattern, options, owner) {
  return {
    pattern: compilePathPattern(pattern),
    path: pattern,
    owner,
    auth: options?.auth ?? DEFAULT_AUTH,
    maxBodyBytes: options?.maxBodyBytes,
  };
}

/**
 * The deployment's backend proxies, one per pattern.
 *
 * The backend prefixes the frontend server proxies. The renderer hardcodes
 * none: a frontend module declares them in its `dms.server.ts`
 * (`registerBackendProxy`), and a backend module in the frontend manifest
 * (`backendProxies`, next to its `publicEndpoints`). A path no prefix covers is
 * never sent to the backend.
 *
 * @param {readonly ProxyDeclaration[]} declared `{ id, pattern, options }` per `registerBackendProxy` call,
 *   from the highest-priority module down
 * @param {readonly (ManifestProxy | null | undefined)[]} manifest `{ module, path, auth?, maxBodyBytes? }` per backend
 *   module declaration
 * @param {(message: string) => void} warn Reports a declaration problem
 * @returns {BackendProxy[]} The proxies, the most specific pattern first: a request reaches
 *   the first that matches
 */
export function resolveBackendProxies(declared, manifest, warn) {
  /** @type {Map<string | undefined, BackendProxy>} */
  const kept = new Map();
  /**
   * @param {string | undefined} pattern
   * @param {ProxyOptions | undefined} options
   * @param {string} owner
   */
  const add = (pattern, options, owner) => {
    const reason = proxyRejection(pattern, options);
    const current = kept.get(pattern);
    if (reason || current) {
      warn(
        `${owner} declares the backend proxy "${pattern}", which is ignored: ${reason ?? `${current.owner} declares it`}.`,
      );
      return;
    }
    kept.set(pattern, compileProxy(pattern, options, owner));
  };
  for (const { id, pattern, options } of declared)
    add(pattern, options, `Frontend module ${id}`);
  for (const entry of manifest)
    add(
      entry?.path,
      { auth: entry?.auth, maxBodyBytes: entry?.maxBodyBytes },
      `Backend module ${entry?.module}`,
    );
  return [...kept.values()].sort(
    (left, right) => right.pattern.specificity - left.pattern.specificity,
  );
}

/**
 * The backend proxy a path reaches, or `undefined`.
 *
 * @param {readonly BackendProxy[]} proxies
 * @param {string} pathname
 */
export function matchBackendProxy(proxies, pathname) {
  return proxies.find((proxy) => proxy.pattern.test(pathname));
}

/**
 * The lines the server prints at startup: each backend prefix, who declared
 * it and how it authenticates, then who owns the rest.
 *
 * @param {readonly BackendProxy[]} proxies What `resolveBackendProxies` returned
 * @param {number} routeCount The number of module routes
 */
export function routingReport(proxies, routeCount) {
  const width = Math.max(0, ...proxies.map((proxy) => proxy.path.length));
  const lines = proxies.map(
    (proxy) =>
      `  ${proxy.path.padEnd(width)}  -> backend (${proxy.auth}), declared by ${proxy.owner.replace(/^\w+ module /, "")}`,
  );
  return [
    `Routing: renderer files, then ${routeCount} module route${routeCount === 1 ? "" : "s"}, then the backend proxies below, then the pages`,
    ...(lines.length
      ? lines
      : ["  (no backend proxy declared: no request reaches the backend)"]),
  ];
}
