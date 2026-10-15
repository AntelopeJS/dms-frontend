// The props of a DMS page visit, and which of them the browser already has.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows.

import { createHash } from "node:crypto";
import { readSession } from "./auth/session.mjs";
import { BackendResponseError } from "./backend-response.mjs";
import { heldOnceProps, requestedProps } from "./inertia.mjs";

export const SHARED_PROP = "shared";
/**
 * How long a browser reuses the site layout it was sent before a visit asks
 * for it again. The layout is the whole menu with each entry's access, the
 * bulk of every page object; a change the backend announces (`menu-changed`)
 * reloads it sooner, and the backend checks access on every request whatever
 * the menu shows.
 */
export const SHARED_PROP_TTL_MS = 5 * 60 * 1000;
const SITE_LAYOUT_PATH = "/dms/sitelayout";
const NOT_FOUND = 404;

/**
 * The once-prop key of the site layout: one per account and workspace. A
 * browser holding the layout of another account or workspace, after a sign-in,
 * a sign-out or a switch, holds another key, so it is sent the right one.
 */
export function sharedOnceKey(session) {
  const identity = `${session?.accountId ?? ""}\n${session?.activeTenantId ?? ""}`;
  const digest = createHash("sha256").update(identity).digest("base64url");
  return `${SHARED_PROP}:${digest.slice(0, 16)}`;
}

/**
 * Whether the browser holds this session's layout and no other: a browser
 * that holds another session's key too (a switch back and forth without a
 * full visit) may show that one under `shared`, so it is sent this one.
 */
function holdsOnlyThisLayout(held, sharedKey) {
  if (!held.has(sharedKey)) return false;
  return ![...held].some(
    (key) => key !== sharedKey && key.startsWith(`${SHARED_PROP}:`),
  );
}

function pagePath(pathname, withShared) {
  const query = new URLSearchParams({ path: pathname });
  if (!withShared) query.set(SHARED_PROP, "false");
  return `/dms/page?${query}`;
}

/** A page only the frontend has: a custom page, with no backend data. */
function frontendOnlyPage(pathname, signInPath) {
  return {
    componentName: pathname,
    isFrontendOnly: true,
    route: {
      fullId: pathname.slice(1).replaceAll("/", "."),
      fullSlug: pathname,
      hasAccess: pathname.startsWith(`${signInPath}/`),
    },
    layout: { layout: { componentName: "DefaultLayout" } },
  };
}

async function loadPage(
  pathname,
  withShared,
  { fetchJson, isFrontendPage },
  signInPath,
) {
  try {
    const { shared, ...page } = await fetchJson(pagePath(pathname, withShared));
    return { page, shared };
  } catch (error) {
    if (!(error instanceof BackendResponseError) || error.status !== NOT_FOUND)
      throw error;
    if (!(await isFrontendPage(pathname))) throw error;
    return {
      page: frontendOnlyPage(pathname, signInPath),
      shared: undefined,
    };
  }
}

/**
 * The props of the page a request visits, with the once props to declare.
 *
 * The site layout (`shared`) is a once prop: a visit sends it when the browser
 * does not hold it for this account and workspace, or when a partial reload
 * asks for it, and otherwise asks the backend for the page alone. A partial
 * reload gets the props it names, and the layout too when the browser's copy
 * is not this session's.
 */
export async function loadPageProps(request, backend, auth) {
  const pathname = new URL(request.url, "http://frontend.local").pathname;
  const sealed = readSession(request);
  const { user, session } = auth.view(sealed);
  const { partial, wants } = requestedProps(request);
  // The sealed session names the account and workspace, whatever the module
  // owning sign-in shows a page of it.
  const sharedKey = sharedOnceKey(sealed);
  const holdsShared = holdsOnlyThisLayout(heldOnceProps(request), sharedKey);
  const withShared = (partial && wants(SHARED_PROP)) || !holdsShared;
  const props = {};
  if (wants("path")) props.path = pathname;
  // A partial reload merges what it gets into the page on screen: a session
  // that ended has to be sent as one, not left out.
  if (wants("user") && (user || partial)) props.user = user ?? null;
  if (wants("session") && (session || partial)) props.session = session ?? null;
  let shared;
  if (wants("page")) {
    const loaded = await loadPage(
      pathname,
      withShared,
      backend,
      auth.signInPath,
    );
    props.page = loaded.page;
    shared = loaded.shared;
  } else if (withShared) {
    shared = await backend.fetchJson(SITE_LAYOUT_PATH);
  }
  if (shared) props[SHARED_PROP] = shared;
  // Declared only when the browser ends up with this session's layout: sent
  // now, or already held. Declaring it otherwise would let a layout of
  // another session pass for this one.
  const onceProps =
    shared || holdsShared
      ? {
          [sharedKey]: {
            prop: SHARED_PROP,
            expiresAt: shared ? Date.now() + SHARED_PROP_TTL_MS : null,
          },
        }
      : undefined;
  return { props, onceProps };
}
