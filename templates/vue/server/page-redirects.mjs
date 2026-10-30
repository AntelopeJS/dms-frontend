import { readSession } from "./auth/session.mjs";
import { HOMEPAGE } from "./homepage.mjs";
import { redirectFrontendVisit } from "./inertia.mjs";
import { pageRoute } from "./page-props.mjs";
import { isObjectLike } from "./type-guards.mjs";

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {string} pathname
 * @returns {boolean}
 */
export function redirectToHomepage(request, response, pathname) {
  if (pathname !== "/" || HOMEPAGE === "/") return false;
  redirectFrontendVisit(request, response, HOMEPAGE);
  return true;
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 * @param {import("./page-props.mjs").PageProps} props
 * @param {import("./module-server.mjs").ServerModules["serverAuth"]} auth
 * @returns {boolean}
 */
export function redirectSignedOutPrivatePage(request, response, props, auth) {
  const route = pageRoute(props);
  if (
    !isObjectLike(route) ||
    route.publicAccess === true ||
    route.hasAccess !== false ||
    readSession(request)
  )
    return false;
  redirectFrontendVisit(request, response, auth.signInLocation(request.url));
  return true;
}
