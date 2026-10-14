// The routes the renderer still serves for the DMS and the API tester. Their
// owners serve them from their own `dms.server.ts`; a module route on the same
// method and path shadows the built-in one, which stays as the fallback for a
// module release that predates it.

import { handleAuth } from "./auth/routes.mjs";
import { handleEmailRender } from "./email.mjs";
import { handleTester } from "./tester.mjs";

const AUTH_SERVER_ROUTES = [
  ["GET", /^\/api\/_auth\/session\/?$/],
  ["POST", /^\/api\/_auth\/session\/?$/],
  ["DELETE", /^\/api\/_auth\/session\/?$/],
  [
    "POST",
    /^\/auth\/(?:login|signup|verify-2fa|establish|request-2fa-email|switch-account|switch-tenant|validate-account|remove-account)\/?$/,
  ],
  ["POST", /^\/auth\/oauth\/handoff\/?$/],
  ["GET", /^\/auth\/oauth\/[^/]+\/(?:start|callback)\/?$/],
];
const HTML_RENDER_ROUTE = "/api/html/render";
const TESTER_ROUTE = /^\/api\/_dms\/tester\/?$/;

/** Whether `method` and `pathname` reach a built-in auth route. */
export function isBuiltInAuthRoute(method, pathname) {
  return AUTH_SERVER_ROUTES.some(
    ([routeMethod, pattern]) =>
      routeMethod === method && pattern.test(pathname),
  );
}

/**
 * The built-in route the server answers `method` and `pathname` with, as a
 * `(request, response, url)` handler, or `undefined`.
 */
export function builtInRoute(method, pathname) {
  if (TESTER_ROUTE.test(pathname)) return handleTester;
  if (pathname === "/api/_auth/session") return handleAuth;
  if (method === "POST" && pathname === HTML_RENDER_ROUTE)
    return handleEmailRender;
  return isBuiltInAuthRoute(method, pathname) ? handleAuth : undefined;
}
