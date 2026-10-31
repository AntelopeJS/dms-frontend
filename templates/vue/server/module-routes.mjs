import { resolveBackendProxies } from "./backend-proxies.mjs";
import { compilePathPattern } from "./path-patterns.mjs";
import { matchPublicEndpoint } from "./public-endpoints.mjs";
import { ruleRejection } from "./route-rules.mjs";
import {
  isBoolean,
  isFunction,
  isNonNullObject,
  isString,
} from "./type-guards.mjs";

/** @typedef {(message: string) => void} Warn */
/**
 * @import {
 *   AuthProvider, DeclaredModule, ModuleDeclared, RouteRegistration,
 *   ServerDeclarations, ServerModuleDeclaration, ServerRoute
 * } from "./module-route-types.mjs"
 * @import { PublicEndpoint } from "./public-endpoints.mjs"
 */

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const LITERAL_SEGMENT = /^[A-Za-z0-9._~-]+$/;
const PARAM_SEGMENT = /^:([A-Za-z_][A-Za-z0-9_]*)$/;
const DEFAULT_BODY_LIMIT = 64 * 1024;
/**
 * The renderer's own paths: its icon endpoint, Vite's URLs and the built
 * assets. No module route is ever served there.
 */
const RESERVED_PREFIXES = ["/api/_dms/", "/@", "/assets/", "/node_modules/"];
/** The backend's namespace, which the proxy forwards. */
const BACKEND_PREFIX = /^\/(?:api|dms)(?:\/|$)/;
/** A module's own namespace under `/api/`, which the backend does not use. */
const MODULE_API_PREFIX = /^\/api\/_[A-Za-z0-9-]+(?:\/|$)/;

/**
 * Whether `pathname` names one of the files the renderer serves: Vite's URLs,
 * the built assets and the dependencies. No server route is ever there, and a
 * development page requests hundreds of them.
 *
 * @param {string} pathname
 */
export function isRendererFilePath(pathname) {
  return ["/@", "/assets/", "/node_modules/"].some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/**
 * Whether a module route may serve `pathname`: never the renderer's own.
 *
 * @param {string} pathname
 */
export function mayHaveModuleRoute(pathname) {
  return !RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

/** @param {string} path */
function normalizedPath(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

/** @param {string} path */
function pathRejection(path) {
  if (!isString(path) || !path.startsWith("/")) return "a path starts with /";
  const normalized = normalizedPath(path);
  if (!mayHaveModuleRoute(normalized))
    return `${RESERVED_PREFIXES.join(", ")} are the renderer's own paths`;
  if (normalized === "/") return undefined;
  const segments = normalized.slice(1).split("/");
  const names = new Set();
  for (const segment of segments) {
    const param = segment.match(PARAM_SEGMENT)?.[1];
    if (param) {
      if (names.has(param)) return `the parameter :${param} is repeated`;
      names.add(param);
    } else if (
      !LITERAL_SEGMENT.test(segment) ||
      segment === "." ||
      segment === ".."
    )
      return `"${segment}" is neither a literal segment nor a :name parameter`;
  }
  return undefined;
}

/** @param {RouteRegistration["options"]} options */
function optionsRejection(options) {
  if (options === undefined) return undefined;
  if (!isNonNullObject(options)) return "its options are not an object";
  if (options.sameOrigin !== undefined && !isBoolean(options.sameOrigin))
    return "sameOrigin is not a boolean";
  if (
    options.bodyLimit !== undefined &&
    !(Number.isSafeInteger(options.bodyLimit) && options.bodyLimit >= 0)
  )
    return "bodyLimit is not a byte count";
  return undefined;
}

/**
 * Two declarations of one path whatever their parameters are named share a
 * path identity.
 *
 * @param {string} path
 */
function compilePath(path) {
  const normalized = normalizedPath(path);
  const segments = normalized === "/" ? [] : normalized.slice(1).split("/");
  /** @type {string[]} */
  const params = [];
  const pattern = segments
    .map((segment) => {
      const param = segment.match(PARAM_SEGMENT)?.[1];
      if (!param) return `/${segment.replaceAll(".", "\\.")}`;
      params.push(param);
      return "/([^/]+)";
    })
    .join("");
  return {
    path: normalized,
    pathIdentity: segments
      .map((segment) => (PARAM_SEGMENT.test(segment) ? ":" : segment))
      .join("/"),
    params,
    matcher: new RegExp(`^${pattern || ""}/?$`),
  };
}

/**
 * What a module's setup declares, by kind, in declaration order.
 *
 * @param {ServerModuleDeclaration["setup"]} setup
 * @returns {ModuleDeclared}
 */
function collectDeclarations(setup) {
  /** @type {ModuleDeclared} */
  const declared = { routes: [], auth: [], rules: [], proxies: [] };
  setup({
    registerRoute: (method, path, handler, options) =>
      declared.routes.push({ method, path, handler, options }),
    registerAuth: (auth) => declared.auth.push(auth),
    registerRouteRules: (rules) => declared.rules.push(rules),
    registerBackendProxy: (pattern, options) =>
      declared.proxies.push({ pattern, options }),
  });
  return declared;
}

/** @param {unknown} method */
function methodsOf(method) {
  /** @type {readonly unknown[]} */
  const methods = Array.isArray(method) ? method : [method];
  return methods.length && methods.every((name) => METHODS.has(name))
    ? methods
    : undefined;
}

/** @param {RouteRegistration} registration */
function registrationRejection(registration) {
  if (!methodsOf(registration.method))
    return `the method is not one of ${[...METHODS].join(", ")}`;
  if (!isFunction(registration.handler)) return "its handler is not a function";
  return (
    pathRejection(registration.path) ?? optionsRejection(registration.options)
  );
}

/**
 * @param {RouteRegistration["method"]} method
 * @param {string} path
 */
function describeRoute(method, path) {
  return `"${[method].flat().join(", ")} ${path}"`;
}

/**
 * @param {string} id
 * @param {ServerRoute} route
 */
function backendShadowWarning(id, route) {
  if (
    !BACKEND_PREFIX.test(route.path) ||
    MODULE_API_PREFIX.test(route.path) ||
    route.overridesBackend
  )
    return undefined;
  return (
    `Frontend module ${id} serves ${describeRoute(route.method, route.path)} from the frontend server, ` +
    "which hides whatever the backend serves there. Use a path under /api/_<module>/, " +
    "or pass { overridesBackend: true } if that is the intent."
  );
}

/**
 * @param {string} id
 * @param {ServerRoute} route
 * @param {PublicEndpoint[]} publicEndpoints
 */
function publicEndpointWarning(id, route, publicEndpoints) {
  const sample = route.path.replaceAll(/\/:[^/]+/g, "/x");
  if (!matchPublicEndpoint(route.method, sample, publicEndpoints))
    return undefined;
  return (
    `Frontend module ${id} serves ${describeRoute(route.method, route.path)}, ` +
    "a public endpoint a backend module declared: the module route answers it, not the backend."
  );
}

/**
 * Runs a module's setup; a setup that throws declares nothing.
 *
 * @param {ServerModuleDeclaration} declaration
 * @param {Warn} warn
 */
function declarationsOfModule(declaration, warn) {
  try {
    return collectDeclarations(declaration.setup);
  } catch (error) {
    warn(
      `Frontend module ${declaration.id} has a dms.server.ts that failed to declare its routes, which are ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * @param {DeclaredModule} module
 * @param {Warn} warn
 * @returns {ServerRoute[]}
 */
function routesOfModule(module, warn) {
  const { id, priority = 0 } = module;
  return module.declared.routes.flatMap((registration, order) => {
    const reason = registrationRejection(registration);
    if (reason) {
      warn(
        `Frontend module ${id} declares route ${describeRoute(registration.method, registration.path)}, which is ignored: ${reason}.`,
      );
      return [];
    }
    const compiled = compilePath(registration.path);
    return methodsOf(registration.method).map((method) => ({
      ...compiled,
      id,
      priority,
      order,
      method,
      handler: registration.handler,
      sameOrigin: registration.options?.sameOrigin ?? true,
      bodyLimit: registration.options?.bodyLimit ?? DEFAULT_BODY_LIMIT,
      overridesBackend: registration.options?.overridesBackend === true,
    }));
  });
}

/**
 * @param {{ id: string, priority?: number }} left
 * @param {{ id: string, priority?: number }} right
 */
function byPriority(left, right) {
  return (
    (right.priority ?? 0) - (left.priority ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * @param {ServerRoute} kept
 * @param {ServerRoute} shadowed
 */
function shadowWarning(kept, shadowed) {
  const settled =
    kept.priority === shadowed.priority
      ? "same priority, the first module id wins"
      : "the higher priority wins";
  return (
    `${describeRoute(shadowed.method, shadowed.path)}: ${shadowed.id} (priority ${shadowed.priority}) ` +
    `is shadowed by ${kept.id} (priority ${kept.priority}); ${settled}.`
  );
}

/** @param {ServerRoute} route */
function parameterCount(route) {
  return route.params.length;
}

/**
 * Whether one request path can match both routes: as many segments, and at
 * each position the same literal or a parameter on either side.
 *
 * @param {ServerRoute} left
 * @param {ServerRoute} right
 */
function routesOverlap(left, right) {
  const leftSegments =
    left.pathIdentity === "" ? [] : left.pathIdentity.split("/");
  const rightSegments =
    right.pathIdentity === "" ? [] : right.pathIdentity.split("/");
  return (
    leftSegments.length === rightSegments.length &&
    leftSegments.every(
      (segment, index) =>
        segment === ":" ||
        rightSegments[index] === ":" ||
        segment === rightSegments[index],
    )
  );
}

/**
 * `first` is tried before `second`: it answers what both can match.
 *
 * @param {ServerRoute} first
 * @param {ServerRoute} second
 */
function overlapWarning(first, second) {
  const settled =
    parameterCount(first) < parameterCount(second)
      ? "it has fewer parameters"
      : first.priority === second.priority
        ? "same priority, the first module id wins"
        : "the higher priority wins";
  return (
    `${describeRoute(first.method, first.path)} of ${first.id} (priority ${first.priority}) and ` +
    `${describeRoute(second.method, second.path)} of ${second.id} (priority ${second.priority}) ` +
    `can match the same request, which ${first.id} answers: ${settled}.`
  );
}

/** @param {ServerRoute} route */
function rootParameterWarning(route) {
  return (
    `Frontend module ${route.id} serves ${describeRoute(route.method, route.path)}, whose first ` +
    "segment is a parameter: it answers every path of that shape, the pages and other modules' " +
    "routes included. Start the path with a literal segment."
  );
}

/**
 * Reports what the order of `routes` settles silently: two modules' routes
 * that can match one request, and a route that catches every first segment.
 *
 * @param {ServerRoute[]} routes
 * @param {Warn} warn
 */
function warnOverlaps(routes, warn) {
  for (const [index, route] of routes.entries()) {
    if (route.pathIdentity.startsWith(":")) warn(rootParameterWarning(route));
    for (const later of routes.slice(index + 1))
      if (
        later.method === route.method &&
        later.id !== route.id &&
        routesOverlap(route, later)
      )
        warn(overlapWarning(route, later));
  }
}

/**
 * @param {DeclaredModule[]} modules
 * @param {Warn} warn
 * @param {PublicEndpoint[]} publicEndpoints
 */
function resolveRoutes(modules, warn, publicEndpoints) {
  /** @type {Map<string, ServerRoute>} */
  const kept = new Map();
  for (const module of modules) {
    for (const route of routesOfModule(module, warn)) {
      const key = `${route.method} ${route.pathIdentity}`;
      const current = kept.get(key);
      if (current) {
        warn(shadowWarning(current, route));
        continue;
      }
      kept.set(key, route);
      const notice =
        backendShadowWarning(route.id, route) ??
        publicEndpointWarning(route.id, route, publicEndpoints);
      if (notice) warn(notice);
    }
  }
  const routes = [...kept.values()].sort(
    (left, right) =>
      parameterCount(left) - parameterCount(right) ||
      byPriority(left, right) ||
      left.order - right.order,
  );
  warnOverlaps(routes, warn);
  return routes;
}

const AUTH_HOOKS = ["refreshSession", "publicSession"];

/** @param {unknown} auth */
function authRejection(auth) {
  if (!isNonNullObject(auth)) return "it is not an object";
  for (const hook of AUTH_HOOKS)
    if (auth[hook] !== undefined && !isFunction(auth[hook]))
      return `${hook} is not a function`;
  if (
    auth.signInPath !== undefined &&
    (!isString(auth.signInPath) ||
      !compilePathPattern(auth.signInPath) ||
      auth.signInPath.includes("*"))
  )
    return "signInPath is not a page path";
  if (
    auth.signInExempt !== undefined &&
    !(
      Array.isArray(auth.signInExempt) &&
      auth.signInExempt.every((pattern) => compilePathPattern(pattern))
    )
  )
    return "signInExempt is not a list of /x, /x/* or /x/** patterns";
  return undefined;
}

/**
 * The auth hooks: those of the highest-priority module that registers them.
 * A module registering them twice, or after another one, is reported.
 *
 * @param {DeclaredModule[]} modules
 * @param {Warn} warn
 */
function resolveAuth(modules, warn) {
  /** @type {AuthProvider | undefined} */
  let provider;
  for (const module of modules) {
    for (const auth of module.declared.auth) {
      const reason = authRejection(auth);
      if (reason) {
        warn(
          `Frontend module ${module.id} registers auth hooks, which are ignored: ${reason}.`,
        );
        continue;
      }
      if (provider) {
        warn(
          `Frontend module ${module.id} registers auth hooks, which are ignored: ${provider.id} (priority ${provider.priority ?? 0}) provides them.`,
        );
        continue;
      }
      provider = {
        id: module.id,
        priority: module.priority ?? 0,
        signInPath: auth.signInPath,
        signInExempt: auth.signInExempt?.map(compilePathPattern),
        refreshSession: auth.refreshSession,
        publicSession: auth.publicSession,
      };
    }
  }
  return provider;
}

/**
 * The route rules: of two declarations of the same pattern, the module of
 * higher priority keeps it, with a warning.
 *
 * @param {DeclaredModule[]} modules
 * @param {Warn} warn
 */
function resolveRules(modules, warn) {
  /** @type {Map<string, import("./route-rules.mjs").ResolvedRouteRule>} */
  const kept = new Map();
  for (const module of modules) {
    for (const rules of module.declared.rules) {
      if (!isNonNullObject(rules)) {
        warn(
          `Frontend module ${module.id} declares route rules that are ignored: they are not an object.`,
        );
        continue;
      }
      for (const [pattern, rule] of Object.entries(rules)) {
        const reason = ruleRejection(pattern, rule);
        const current = kept.get(pattern);
        if (reason || current) {
          warn(
            `Frontend module ${module.id} declares the route rule "${pattern}", which is ignored: ${reason ?? `${current.id} (priority ${current.priority}) declares it`}.`,
          );
          continue;
        }
        kept.set(pattern, {
          id: module.id,
          priority: module.priority ?? 0,
          pattern: compilePathPattern(pattern),
          rule,
        });
      }
    }
  }
  return [...kept.values()];
}

/**
 * What the modules declared, ready to serve. Each declaration is checked, and
 * a bad one is ignored with a warning naming its module.
 *
 * `routes`: of two declarations of the same method and path, the module of
 * higher priority keeps it, with a warning naming both (module id on a tie).
 * Routes with fewer parameters are tried first, so a literal path is never
 * hidden by a parameter of another route. Two modules' routes that can match
 * the same request, and a route whose first segment is a parameter, are
 * reported too: the order settles them, but silently.
 *
 * `auth`: the auth hooks of the highest-priority module that registers them,
 * `undefined` when none does.
 *
 * `rules`: the route rules, one per pattern.
 *
 * `proxies`: the backend prefixes the modules and the manifest declare, the
 * most specific first (see `backend-proxies.mjs`).
 *
 * The routes frontend modules declare in their `dms.server.ts`: what each
 * declaration is checked against, how conflicts are settled, and which route a
 * request reaches. Pure: the server hands it the declarations it loaded, and
 * `module-event.mjs` runs the handler a request reaches.
 *
 * @param {readonly ServerModuleDeclaration[]} declarations `{ id, priority, setup }` per module with a dms.server.ts
 * @param {Warn} warn Reports a declaration problem
 * @param {PublicEndpoint[]} [publicEndpoints] The deployment's public endpoints (#108), to report a
 *   module route answering one
 * @param {readonly import("./backend-proxies.mjs").ManifestProxy[]} [manifestProxies] `{ module, path, auth? }`, the backend proxies the
 *   backend modules declare in the manifest
 * @returns {ServerDeclarations}
 */
export function resolveServerDeclarations(
  declarations,
  warn,
  publicEndpoints = [],
  manifestProxies = [],
) {
  const modules = [...declarations].sort(byPriority).flatMap((declaration) => {
    const declared = declarationsOfModule(declaration, warn);
    return declared ? [{ ...declaration, declared }] : [];
  });
  return {
    routes: resolveRoutes(modules, warn, publicEndpoints),
    auth: resolveAuth(modules, warn),
    rules: resolveRules(modules, warn),
    proxies: resolveBackendProxies(
      modules.flatMap((module) =>
        module.declared.proxies.map((proxy) => ({ id: module.id, ...proxy })),
      ),
      manifestProxies,
      warn,
    ),
  };
}

/**
 * @param {ServerRoute} route
 * @param {RegExpExecArray} match
 */
function decodedParams(route, match) {
  /** @type {Record<string, string>} */
  const params = {};
  for (const [index, name] of route.params.entries()) {
    try {
      params[name] = decodeURIComponent(match[index + 1]);
    } catch {
      return undefined;
    }
  }
  return params;
}

/**
 * The route a request reaches, with its parameters, or `undefined`.
 *
 * A `HEAD` no route declares is the `GET`'s, without its body.
 *
 * @param {ServerRoute[]} routes What `resolveServerDeclarations` returned
 * @param {string} method The request's method
 * @param {string} pathname The request's normalized path, without its query string
 */
export function matchModuleRoute(routes, method, pathname) {
  const reached = matchMethod(routes, method, pathname);
  if (reached || method !== "HEAD") return reached;
  return matchMethod(routes, "GET", pathname);
}

/**
 * @param {ServerRoute[]} routes
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: ServerRoute, params: Record<string, string> } | undefined}
 */
function matchMethod(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.matcher.exec(pathname);
    if (!match) continue;
    const params = decodedParams(route, match);
    if (params) return { route, params };
  }
  return undefined;
}

/**
 * The methods the module routes answer on `pathname`: a path a module route
 * serves is that module's for every method, the others answered `405`.
 *
 * @param {ServerRoute[]} routes
 * @param {string} pathname
 */
export function moduleRouteMethods(routes, pathname) {
  /** @type {Set<string>} */
  const methods = new Set();
  for (const route of routes)
    if (route.matcher.test(pathname)) methods.add(route.method);
  if (methods.has("GET")) methods.add("HEAD");
  return [...methods];
}
