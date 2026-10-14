// The routes frontend modules declare in their `dms.server.ts`: what each
// declaration is checked against, how conflicts are settled, and which route a
// request reaches. Pure: the server hands it the declarations it loaded, and
// `module-event.mjs` runs the handler a request reaches.

import { compilePathPattern } from "./path-patterns.mjs";
import { matchPublicEndpoint } from "./public-endpoints.mjs";
import { ruleRejection } from "./route-rules.mjs";

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
 */
export function isRendererFilePath(pathname) {
  return ["/@", "/assets/", "/node_modules/"].some((prefix) =>
    pathname.startsWith(prefix),
  );
}

/** Whether a module route may serve `pathname`: never the renderer's own. */
export function mayHaveModuleRoute(pathname) {
  return !RESERVED_PREFIXES.some(
    (prefix) => pathname === prefix.slice(0, -1) || pathname.startsWith(prefix),
  );
}

function normalizedPath(path) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function pathRejection(path) {
  if (typeof path !== "string" || !path.startsWith("/"))
    return "a path starts with /";
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

function optionsRejection(options) {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null)
    return "its options are not an object";
  if (
    options.sameOrigin !== undefined &&
    typeof options.sameOrigin !== "boolean"
  )
    return "sameOrigin is not a boolean";
  if (
    options.bodyLimit !== undefined &&
    !(Number.isSafeInteger(options.bodyLimit) && options.bodyLimit >= 0)
  )
    return "bodyLimit is not a byte count";
  return undefined;
}

function compilePath(path) {
  const normalized = normalizedPath(path);
  const segments = normalized === "/" ? [] : normalized.slice(1).split("/");
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
    // Two declarations of one path whatever their parameters are named.
    shape: segments
      .map((segment) => (PARAM_SEGMENT.test(segment) ? ":" : segment))
      .join("/"),
    params,
    matcher: new RegExp(`^${pattern || ""}/?$`),
  };
}

/** What a module's setup declares, by kind, in declaration order. */
function collectDeclarations(setup) {
  const declared = { routes: [], auth: [], rules: [] };
  setup({
    registerRoute: (method, path, handler, options) =>
      declared.routes.push({ method, path, handler, options }),
    registerAuth: (auth) => declared.auth.push(auth),
    registerRouteRules: (rules) => declared.rules.push(rules),
  });
  return declared;
}

function methodsOf(method) {
  const methods = Array.isArray(method) ? method : [method];
  return methods.length && methods.every((name) => METHODS.has(name))
    ? methods
    : undefined;
}

function registrationRejection(registration) {
  if (!methodsOf(registration.method))
    return `the method is not one of ${[...METHODS].join(", ")}`;
  if (typeof registration.handler !== "function")
    return "its handler is not a function";
  return (
    pathRejection(registration.path) ?? optionsRejection(registration.options)
  );
}

function describeRoute(method, path) {
  return `"${[method].flat().join(", ")} ${path}"`;
}

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

function publicEndpointWarning(id, route, publicEndpoints) {
  const sample = route.path.replaceAll(/\/:[^/]+/g, "/x");
  if (!matchPublicEndpoint(route.method, sample, publicEndpoints))
    return undefined;
  return (
    `Frontend module ${id} serves ${describeRoute(route.method, route.path)}, ` +
    "a public endpoint a backend module declared: the module route answers it, not the backend."
  );
}

/** Runs a module's setup; a setup that throws declares nothing. */
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

function byPriority(left, right) {
  return (
    (right.priority ?? 0) - (left.priority ?? 0) ||
    left.id.localeCompare(right.id)
  );
}

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

function parameterCount(route) {
  return route.params.length;
}

function resolveRoutes(modules, warn, publicEndpoints) {
  const kept = new Map();
  for (const module of modules) {
    for (const route of routesOfModule(module, warn)) {
      const key = `${route.method} ${route.shape}`;
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
  return [...kept.values()].sort(
    (left, right) =>
      parameterCount(left) - parameterCount(right) ||
      byPriority(left, right) ||
      left.order - right.order,
  );
}

const AUTH_HOOKS = ["refreshSession", "publicSession"];

function authRejection(auth) {
  if (typeof auth !== "object" || auth === null) return "it is not an object";
  for (const hook of AUTH_HOOKS)
    if (auth[hook] !== undefined && typeof auth[hook] !== "function")
      return `${hook} is not a function`;
  if (
    auth.signInPath !== undefined &&
    (typeof auth.signInPath !== "string" ||
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
 */
function resolveAuth(modules, warn) {
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
 */
function resolveRules(modules, warn) {
  const kept = new Map();
  for (const module of modules) {
    for (const rules of module.declared.rules) {
      if (typeof rules !== "object" || rules === null) {
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
 * hidden by a parameter of another route.
 *
 * `auth`: the auth hooks of the highest-priority module that registers them,
 * `undefined` when none does.
 *
 * `rules`: the route rules, one per pattern.
 *
 * @param declarations `{ id, priority, setup }` per module with a dms.server.ts
 * @param warn Reports a declaration problem
 * @param publicEndpoints The deployment's public endpoints (#108), to report a
 *   module route answering one
 */
export function resolveServerDeclarations(
  declarations,
  warn,
  publicEndpoints = [],
) {
  const modules = [...declarations].sort(byPriority).flatMap((declaration) => {
    const declared = declarationsOfModule(declaration, warn);
    return declared ? [{ ...declaration, declared }] : [];
  });
  return {
    routes: resolveRoutes(modules, warn, publicEndpoints),
    auth: resolveAuth(modules, warn),
    rules: resolveRules(modules, warn),
  };
}

function decodedParams(route, match) {
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
 * @param routes What `resolveServerDeclarations` returned
 * @param method The request's method
 * @param pathname The request's normalized path, without its query string
 */
export function matchModuleRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = route.matcher.exec(pathname);
    if (!match) continue;
    const params = decodedParams(route, match);
    if (params) return { route, params };
  }
  return undefined;
}
