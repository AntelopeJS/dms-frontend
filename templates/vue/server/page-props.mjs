import { createHash } from "node:crypto";
import { readSession } from "./auth/session.mjs";
import { BackendResponseError } from "./backend-response.mjs";
import { heldOnceProps, requestedProps } from "./inertia.mjs";
import { isNonNullObject, isObjectLike } from "./type-guards.mjs";

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
 * The props of a page, each only when the request asks for it.
 *
 * @typedef {{
 *   path?: string,
 *   user?: unknown,
 *   session?: unknown,
 *   page?: unknown,
 *   shared?: unknown
 * }} PageProps
 */

/**
 * What a page request reads of the backend: its JSON for a path, and whether
 * the frontend itself serves a path.
 *
 * @typedef {{
 *   fetchJson: (path: string) => Promise<unknown>,
 *   isFrontendPage: (pathname: string) => Promise<boolean>
 * }} PageBackend
 */

/**
 * What a page request reads of the auth hooks: where sign-in is, and what a
 * session shows a page.
 *
 * @typedef {{
 *   signInPath: string,
 *   view: (session: unknown) => { user?: unknown, session?: unknown }
 * }} PageAuth
 */

/**
 * The route the backend described for the page of `props`, as the backend
 * sent it: any JSON value, `undefined` when the page has none.
 *
 * @param {PageProps} props
 * @returns {unknown}
 */
export function pageRoute(props) {
  return isObjectLike(props.page) ? props.page.route : undefined;
}

/**
 * The once-prop key of the site layout: one per account and workspace. A
 * browser holding the layout of another account or workspace, after a sign-in,
 * a sign-out or a switch, holds another key, so it is sent the right one.
 *
 * @param {unknown} session The sealed session: any JSON value, since only its
 *   `accountId` and `activeTenantId` are read, as empty when it holds none
 * @returns {string}
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
 *
 * @param {Set<string>} held
 * @param {string} sharedKey
 * @returns {boolean}
 */
function holdsOnlyThisLayout(held, sharedKey) {
  if (!held.has(sharedKey)) return false;
  return ![...held].some(
    (key) => key !== sharedKey && key.startsWith(`${SHARED_PROP}:`),
  );
}

/**
 * The parameters of the page request itself, which a page query of the same
 * name cannot override.
 */
const PAGE_REQUEST_PARAMETERS = new Set(["path", SHARED_PROP]);

/**
 * The backend request of a page, with the query of the visit: a header
 * button's availability reads it (`?workspace=` names the record a page acts
 * on), so the layout is resolved for the query the browser shows and the
 * browser does not ask it again. One value per name, the last, as the
 * browser's own page layout request sends it.
 *
 * @param {URL} url
 * @param {boolean} withShared
 * @returns {string}
 */
function pagePath(url, withShared) {
  const query = new URLSearchParams({ path: url.pathname });
  /** @type {Map<string, string>} */
  const pageQuery = new Map();
  for (const [name, value] of url.searchParams) {
    if (!PAGE_REQUEST_PARAMETERS.has(name)) pageQuery.set(name, value);
  }
  for (const [name, value] of pageQuery) query.set(name, value);
  if (!withShared) query.set(SHARED_PROP, "false");
  return `/dms/page?${query}`;
}

/**
 * A page only the frontend has: a custom page, with no backend data.
 *
 * @param {string} pathname
 * @param {string} signInPath
 */
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

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return isNonNullObject(value);
}

/**
 * @param {URL} url
 * @param {boolean} withShared
 * @param {PageBackend} backend
 * @param {string} signInPath
 */
async function loadPage(
  url,
  withShared,
  { fetchJson, isFrontendPage },
  signInPath,
) {
  const { pathname } = url;
  try {
    const answer = await fetchJson(pagePath(url, withShared));
    if (!isRecord(answer))
      throw new TypeError("The backend's page answer is not an object");
    const { shared, ...page } = answer;
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
 * The props of the same page at another query of its path (`url`): the page
 * is read again, since its layout reads the query, and the rest is kept,
 * the site layout included.
 *
 * @param {PageProps} props
 * @param {URL} url
 * @param {PageBackend} backend
 * @param {PageAuth} auth
 * @returns {Promise<PageProps>}
 */
export async function propsForQuery(props, url, backend, auth) {
  const { page } = await loadPage(url, false, backend, auth.signInPath);
  return { ...props, page };
}

/**
 * The props of the page a request visits, with the once props to declare.
 *
 * The site layout (`shared`) is a once prop: a visit sends it when the browser
 * does not hold it for this account and workspace, or when a partial reload
 * asks for it, and otherwise asks the backend for the page alone. A partial
 * reload gets the props it names, and the layout too when the browser's copy
 * is not this session's.
 *
 * The sealed session names the account and workspace, whatever the module
 * owning sign-in shows a page of it.
 *
 * A partial reload merges what it gets into the page on screen: a session that
 * ended has to be sent as one, not left out.
 *
 * The shared layout is declared only when the browser ends up with this
 * session's layout, sent now or already held: declaring it otherwise would let
 * a layout of another session pass for this one.
 *
 * @param {import("node:http").IncomingMessage} request
 * @param {PageBackend} backend
 * @param {PageAuth} auth
 * @returns {Promise<{
 *   props: PageProps,
 *   onceProps: import("./inertia.mjs").OnceProps | undefined
 * }>}
 */
export async function loadPageProps(request, backend, auth) {
  const url = new URL(request.url, "http://frontend.local");
  const { pathname } = url;
  const sealed = readSession(request);
  const { user, session } = auth.view(sealed);
  const { partial, wants } = requestedProps(request);
  const sharedKey = sharedOnceKey(sealed);
  const holdsShared = holdsOnlyThisLayout(heldOnceProps(request), sharedKey);
  const withShared = (partial && wants(SHARED_PROP)) || !holdsShared;
  /** @type {PageProps} */
  const props = {};
  if (wants("path")) props.path = pathname;
  if (wants("user") && (user || partial)) props.user = user ?? null;
  if (wants("session") && (session || partial)) props.session = session ?? null;
  /** @type {unknown} */
  let shared;
  if (wants("page")) {
    const loaded = await loadPage(url, withShared, backend, auth.signInPath);
    props.page = loaded.page;
    shared = loaded.shared;
  } else if (withShared) {
    shared = await backend.fetchJson(SITE_LAYOUT_PATH);
  }
  if (shared) props[SHARED_PROP] = shared;
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
