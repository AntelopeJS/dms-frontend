// A backend redirect is the browser's to follow. Followed server-side, a
// redirect to another site served that site's page, and set its cookies, on
// the frontend's origin, and a redirect on the backend lost its Location.
// The proxy fetches with `redirect: "manual"` and relays the redirect instead.

/** The statuses that send the client to their `Location`. */
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Whether `url` is on the backend's origin. */
export function isBackendUrl(
  url,
  backendBaseUrl = process.env.DMS_API_BASE_URL,
) {
  const origin = originOf(url);
  return origin !== undefined && origin === originOf(backendBaseUrl);
}

/**
 * The `Location` the client gets for a backend answer fetched from
 * `fetchedUrl`. The proxy keeps the path, so a location on the backend's
 * origin becomes the same path on the frontend's when the frontend sends that
 * path to the backend: the backend's origin is often unreachable from the
 * browser. A backend path the frontend does not proxy (a route outside every
 * declared backend proxy) stays an absolute backend URL, which the browser
 * follows to the backend. Another site's location is kept.
 *
 * @param location The backend's `Location`
 * @param fetchedUrl The backend URL the answer came from
 * @param isProxiedPath `(pathname) => boolean`, whether the frontend server
 *   sends that path to the backend
 */
export function relayedLocation(
  location,
  fetchedUrl,
  isProxiedPath = () => false,
) {
  let target;
  try {
    target = new URL(location, fetchedUrl);
  } catch {
    return location;
  }
  if (target.origin !== originOf(fetchedUrl)) return location;
  if (!isProxiedPath(target.pathname)) return target.href;
  const path = `${target.pathname}${target.search}${target.hash}`;
  // `//host` would name another host: `/.` keeps it a path.
  return path.startsWith("//") ? `/.${path}` : path;
}

/**
 * The cookies of a `Response` a module route returns. A fetch that followed a
 * redirect to another site would set that site's cookies on the frontend's
 * origin: those are dropped.
 */
export function relayableCookies(answer) {
  if (answer.redirected && !isBackendUrl(answer.url)) return [];
  return answer.headers.getSetCookie();
}
