/**
 * Where the generated server answers the Iconify API, as
 * `<ICON_API_PATH><prefix>.json?icons=a,b`. Under `/api/_dms/`, the prefix the
 * server already answers itself, so it can never shadow a page or be proxied to
 * the backend.
 */
export const ICON_API_PATH = "/api/_dms/icons/";

/**
 * The `@iconify/vue` API provider serving every icon the client bundle lacks
 * from `origin`, instead of `api.iconify.design` and its fallbacks.
 */
export function sameOriginIconProvider(origin) {
  return { resources: [origin], path: ICON_API_PATH };
}
