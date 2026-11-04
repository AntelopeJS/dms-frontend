import { readSession, setRequestSession } from "./auth/session.mjs";
import { createServerEvent } from "./module-event.mjs";
import { compilePathPattern } from "./path-patterns.mjs";

const DEFAULT_SIGN_IN_PATH = "/auth";
const DEFAULT_ONBOARDING_PATH = "/onboarding";
/** A hook reads no request body. */
const HOOK_ROUTE = Object.freeze({ bodyLimit: 0 });

/**
 * The pages a signed-out visit reaches when the provider names none: the
 * sign-in page and everything below it, whole segments only (`/auth` exempts
 * `/auth/callback`, never `/authors`), and the onboarding page. Derived from
 * the sign-in path in use, or a custom one would redirect to itself.
 *
 * @param {string} signInPath
 */
function defaultExempt(signInPath) {
  const signIn = signInPath === "/" ? "/" : `${signInPath}/**`;
  return [signIn, DEFAULT_ONBOARDING_PATH].map(compilePathPattern);
}

/**
 * The page props `user` and `session` of `session`, from the provider's
 * `publicSession`. The server adds the `updatedAt` stamp it wrote itself,
 * which the browser compares to drop a page restored from its cache.
 *
 * @param {NonNullable<import("./module-route-types.mjs").AuthProvider["publicSession"]>} publicSession
 * @param {import("./module-event.mjs").Session | undefined} session
 */
function hookView(publicSession, session) {
  if (!session) return {};
  const view = publicSession(session) ?? {};
  return view.session
    ? { ...view, session: { ...view.session, updatedAt: session.updatedAt } }
    : view;
}

/**
 * The server's session logic for a set of server modules.
 *
 * The session logic the server runs outside any route: renewing a session the
 * backend refused, the session a page carries, and where a signed-out visit
 * goes. The module that owns sign-in provides it through `registerAuth` in its
 * `dms.server.ts`. Without one, a page carries no session and a refused session
 * is not renewed.
 *
 * @param {import("./module-route-types.mjs").AuthProvider | undefined} provider The resolved auth hooks, `undefined` when no module
 *   registers any
 * @param {(id: string) => import("./module-server.mjs").ModuleContext} context `(id) => ({ module, app })`, a module's event context
 * @returns `{ provider, signInPath, isSignInExempt, signInLocation, view,
 *   refresh }`
 */
export function serverAuth(provider, context) {
  const signInPath = provider?.signInPath ?? DEFAULT_SIGN_IN_PATH;
  const exempt = provider?.signInExempt ?? defaultExempt(signInPath);
  const publicSession = provider?.publicSession;
  const refreshSession = provider?.refreshSession;
  return {
    provider: provider?.id,
    signInPath,
    isSignInExempt: (/** @type {string} */ pathname) =>
      exempt.some((pattern) => pattern.test(pathname)),
    signInLocation: (/** @type {string} */ requestUrl) =>
      `${signInPath}?redirect=${encodeURIComponent(requestUrl)}`,
    view: publicSession
      ? (
          /** @type {import("./module-event.mjs").Session | undefined} */ session,
        ) => hookView(publicSession, session)
      : () => ({}),
    /**
     * Renews the request's session after the backend refused it. Returns the
     * new session, which the rest of the request runs with, or `undefined`.
     *
     * @param {import("node:http").IncomingMessage} request
     * @param {import("node:http").ServerResponse} response
     */
    async refresh(request, response) {
      if (!refreshSession) return undefined;
      const session = readSession(request);
      if (!session) return undefined;
      const event = createServerEvent({
        request,
        response,
        route: HOOK_ROUTE,
        params: {},
        ...context(provider.id),
      });
      const refreshed = (await refreshSession(event, session)) ?? undefined;
      setRequestSession(request, refreshed);
      return refreshed;
    },
  };
}
