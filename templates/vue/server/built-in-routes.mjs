// The routes the renderer still serves for the DMS and the API tester, until
// 0.6.0. Their owners serve them from their own `dms.server.ts`: a module
// route on the same method and path shadows the built-in one, which stays as
// the fallback for a module release, or a workspace built, before that.

import { handleAuth } from "./auth/routes.mjs";
import { handleEmailRender } from "./email.mjs";
import { matchModuleRoute } from "./module-routes.mjs";
import { handleTester } from "./tester.mjs";

const AUTH_ACTIONS = [
  "login",
  "signup",
  "verify-2fa",
  "establish",
  "request-2fa-email",
  "switch-account",
  "switch-tenant",
  "validate-account",
  "remove-account",
];
const AUTH_SERVER_ROUTES = [
  ["GET", /^\/api\/_auth\/session\/?$/],
  ["POST", /^\/api\/_auth\/session\/?$/],
  ["DELETE", /^\/api\/_auth\/session\/?$/],
  ["POST", new RegExp(`^/auth/(?:${AUTH_ACTIONS.join("|")})/?$`)],
  ["POST", /^\/auth\/oauth\/handoff\/?$/],
  ["GET", /^\/auth\/oauth\/[^/]+\/(?:start|callback)\/?$/],
];
const HTML_RENDER_ROUTE = "/api/html/render";
const TESTER_ROUTE = /^\/api\/_dms\/tester\/?$/;
/** Where the API tester's own module serves it. */
const TESTER_REPLACEMENT = "/api/_dms-api/tester";

/**
 * Every built-in route: its method, its path, the path of one request it
 * answers when the path has a parameter, and the path of the module route
 * that replaces it when that one lives elsewhere.
 */
const BUILT_IN_ROUTES = [
  { method: "GET", path: "/api/_auth/session" },
  { method: "POST", path: "/api/_auth/session" },
  { method: "DELETE", path: "/api/_auth/session" },
  ...AUTH_ACTIONS.map((action) => ({
    method: "POST",
    path: `/auth/${action}`,
  })),
  { method: "POST", path: "/auth/oauth/handoff" },
  ...["start", "callback"].map((step) => ({
    method: "GET",
    path: `/auth/oauth/:provider/${step}`,
    probe: `/auth/oauth/provider/${step}`,
  })),
  { method: "POST", path: HTML_RENDER_ROUTE },
  { method: "POST", path: "/api/_dms/tester", probe: TESTER_REPLACEMENT },
];

/** Whether `method` and `pathname` reach a built-in auth route. */
export function isBuiltInAuthRoute(method, pathname) {
  return AUTH_SERVER_ROUTES.some(
    ([routeMethod, pattern]) =>
      routeMethod === method && pattern.test(pathname),
  );
}

/**
 * The built-in route the server answers `method` and `pathname` with, as a
 * `(request, response, url)` handler, or `undefined`. The API tester's is
 * dropped once its module serves the tester at its own path.
 *
 * @param routes The module routes, which the request did not reach
 */
export function builtInRoute(method, pathname, routes = []) {
  if (TESTER_ROUTE.test(pathname))
    return matchModuleRoute(routes, "POST", TESTER_REPLACEMENT)
      ? undefined
      : handleTester;
  if (pathname === "/api/_auth/session") return handleAuth;
  if (method === "POST" && pathname === HTML_RENDER_ROUTE)
    return handleEmailRender;
  return isBuiltInAuthRoute(method, pathname) ? handleAuth : undefined;
}

/**
 * The built-in routes and hooks still in use, which no module replaces, as
 * the lines the server reports when it starts. None once the DMS and the API
 * tester's module serve their own.
 *
 * @param modules What `loadServerModules` returned
 */
export function builtInFallbacks(modules) {
  const served = BUILT_IN_ROUTES.filter(
    (route) =>
      !matchModuleRoute(
        modules.routes,
        route.method,
        route.probe ?? route.path,
      ),
  ).map((route) => `${route.method} ${route.path}`);
  const lines = [];
  if (served.length)
    lines.push(
      `Built-in routes the renderer still serves, until 0.6.0 (no module serves them): ${served.join(", ")}`,
    );
  if (!modules.serverAuth.provider)
    lines.push(
      "Built-in session hooks in use, until 0.6.0 (no module registers auth hooks)",
    );
  return lines;
}

/**
 * Reports the built-in fallbacks still in use, once the server is up.
 *
 * @param load Resolves to what `loadServerModules` returns
 */
export async function reportBuiltInFallbacks(load) {
  try {
    for (const line of builtInFallbacks(await load())) console.warn(line);
  } catch (error) {
    console.error("DMS server modules failed to load", error);
  }
}
