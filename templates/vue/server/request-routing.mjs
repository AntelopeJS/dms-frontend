import { matchBackendProxy } from "./backend-proxies.mjs";
import { isRendererFilePath, moduleRouteMethods } from "./module-routes.mjs";

const PAGE_METHODS = new Set(["GET", "HEAD"]);

/**
 * The owner of a request.
 *
 * Who answers a request: one owner per path, whoever asks and whatever the
 * method, in this order: 1. the renderer: its icon endpoint, Vite's URLs and
 * the built assets, and any file it has (a development source, a built asset);
 * 2. the module routes of the modules' `dms.server.ts`; 3. the backend proxies
 * the modules declare (`registerBackendProxy`, the manifest's
 * `backendProxies`); 4. the pages, for everything else: a method other than
 * `GET` and `HEAD` on a page path is a `404`.
 *
 * @param method The request's method
 * @param pathname The request's normalized path
 * @param modules What `loadServerModules` returned: `routes` and `proxies`
 * @param hasRendererFile `(pathname) => boolean`, whether the renderer has a
 *   file at that path
 * @returns `{ kind: "renderer" }`, `{ kind: "module", id }`,
 *   `{ kind: "backend", proxy }`, `{ kind: "page" }` or
 *   `{ kind: "not-found" }`
 */
export function requestOwner(method, pathname, modules, hasRendererFile) {
  if (isRendererFilePath(pathname) || hasRendererFile(pathname))
    return { kind: "renderer" };
  const route = modules.routes.find((candidate) =>
    candidate.matcher.test(pathname),
  );
  if (route && moduleRouteMethods(modules.routes, pathname).length)
    return { kind: "module", id: route.id };
  const proxy = matchBackendProxy(modules.proxies ?? [], pathname);
  if (proxy) return { kind: "backend", proxy };
  return PAGE_METHODS.has(method) ? { kind: "page" } : { kind: "not-found" };
}

/**
 * Whether the server sends a request for `pathname` to the backend: a backend
 * `Location` on such a path can become a frontend path (see
 * `proxy-redirects.mjs`).
 *
 * @param pathname A normalized path
 * @param modules What `loadServerModules` returned: `routes` and `proxies`
 * @param hasRendererFile `(pathname) => boolean`, whether the renderer has a
 *   file at that path
 */
export function reachesBackend(
  pathname,
  modules,
  hasRendererFile = () => false,
) {
  return (
    requestOwner("GET", pathname, modules, hasRendererFile).kind === "backend"
  );
}

/** The `x-dms-route-owner` value of an owner, for the development server. */
export function ownerLabel(owner) {
  if (owner.kind === "module") return `module:${owner.id}`;
  if (owner.kind === "backend") return `backend:${owner.proxy.path}`;
  return owner.kind;
}
