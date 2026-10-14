// The session logic the server runs outside any route: renewing a session the
// backend refused, the session a page carries, and where a signed-out visit
// goes. The module that owns sign-in provides it through `registerAuth` in its
// `dms.server.ts`; until every DMS release does, the built-in implementation
// is the default.

import {
  publicSession as builtInPublicSession,
  refreshSession as builtInRefreshSession,
} from "./auth/routes.mjs";
import { readSession, setRequestSession } from "./auth/session.mjs";
import { createServerEvent } from "./module-event.mjs";

const BUILT_IN_SIGN_IN_PATH = "/auth";
const BUILT_IN_ONBOARDING_PATH = "/onboarding";
/** A hook reads no request body. */
const HOOK_ROUTE = Object.freeze({ bodyLimit: 0 });

function builtInExempt(pathname) {
  return (
    pathname.startsWith(BUILT_IN_SIGN_IN_PATH) ||
    pathname === BUILT_IN_ONBOARDING_PATH
  );
}

/**
 * The page props `user` and `session` of `session`, from the provider's
 * `publicSession`. The server adds the `updatedAt` stamp it wrote itself,
 * which the browser compares to drop a page restored from its cache.
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
 * @param provider The resolved auth hooks, `undefined` for the built-in ones
 * @param context `(id) => ({ module, app })`, a module's event context
 * @returns `{ provider, signInPath, isSignInExempt, signInLocation, view,
 *   refresh }`
 */
export function serverAuth(provider, context) {
  const signInPath = provider?.signInPath ?? BUILT_IN_SIGN_IN_PATH;
  const exempt = provider?.signInExempt;
  const publicSession = provider?.publicSession;
  const refreshSession = provider?.refreshSession;
  return {
    provider: provider?.id,
    signInPath,
    isSignInExempt: exempt
      ? (pathname) => exempt.some((pattern) => pattern.test(pathname))
      : builtInExempt,
    signInLocation: (requestUrl) =>
      `${signInPath}?redirect=${encodeURIComponent(requestUrl)}`,
    view: publicSession
      ? (session) => hookView(publicSession, session)
      : builtInPublicSession,
    /**
     * Renews the request's session after the backend refused it. Returns the
     * new session, which the rest of the request runs with, or `undefined`.
     */
    async refresh(request, response) {
      if (!refreshSession) return builtInRefreshSession(request, response);
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
