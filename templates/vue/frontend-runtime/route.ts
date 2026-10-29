import { router as inertiaRouter, usePage } from "@inertiajs/vue3";
import { computed, watch } from "vue";
import {
  type DmsFrontendRuntime,
  type DmsInertiaPage,
  type DmsMiddleware,
  type DmsMiddlewareResult,
} from "./module-registration";
import {
  type DmsNavigationOptions,
  type DmsRoute,
  type DmsRouter,
  type RouteLocationRaw,
} from "./types";
import { registry, runtimeContexts, useDmsRuntime } from "./state";

function extractRouteParams(
  pattern: string | undefined,
  path: string,
): Record<string, string> {
  if (!pattern) return {};
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = path.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) return {};
  const params: Record<string, string> = {};
  const matches = patternSegments.every((segment, index) => {
    if (!segment.startsWith(":")) return segment === pathSegments[index];
    params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? "");
    return true;
  });
  return matches ? params : {};
}

function parseRoute(runtime: DmsFrontendRuntime, url: string): DmsRoute {
  const parsed = new URL(
    url,
    typeof window === "undefined"
      ? "http://frontend.local"
      : window.location.origin,
  );
  return {
    name: parsed.pathname,
    fullPath: `${parsed.pathname}${parsed.search}${parsed.hash}`,
    path: parsed.pathname,
    query: Object.fromEntries(parsed.searchParams),
    params: extractRouteParams(runtime.currentRoutePattern, parsed.pathname),
    meta: {},
    matched: [{}],
  };
}

function hasSameEntries(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => right[key] === left[key])
  );
}

// Every parse builds a new query, params and matched: assigning them as they
// come would re-run each watcher of the route on every call of useDmsRoute,
// though the URL did not change. They are only replaced when their content did.
export function updateRoute(runtime: DmsFrontendRuntime, url: string): void {
  // The meta is the page's, not the URL's: a page declares it, then reads its
  // route, and the middleware the meta selected must still find it.
  const {
    meta: _pageMeta,
    query,
    params,
    matched,
    ...location
  } = parseRoute(runtime, url);
  const route = runtime.route;
  if (!hasSameEntries(query, route.query)) route.query = query;
  if (!hasSameEntries(params, route.params)) route.params = params;
  if (matched.length !== route.matched.length) route.matched = matched;
  Object.assign(route, location);
}

const URL_BASE = "http://frontend.local";

// The URL the browser shows: it may be ahead of the route, which follows
// Inertia's page, when a component wrote it in place (history.replaceState).
function currentUrl(runtime: DmsFrontendRuntime): string {
  if (runtime.isServer || typeof window === "undefined")
    return new URL(runtime.route.fullPath, URL_BASE).href;
  return window.location.href;
}

// One spelling per URL: `a b`, `a+b` and `a%20b` are the same query, as are
// `:` and `%3A`. The origin is kept, so a URL of another site never matches
// the current one, whatever its path.
function normalizeUrl(url: string, base: string): string {
  const parsed = new URL(url, base);
  const search = parsed.searchParams.toString();
  return `${parsed.origin}${parsed.pathname}${search ? `?${search}` : ""}${parsed.hash}`;
}

export function locationToUrl(
  runtime: DmsFrontendRuntime,
  to: RouteLocationRaw,
): string {
  if (typeof to === "string") return to;
  const origin =
    typeof window === "undefined"
      ? "http://frontend.local"
      : window.location.origin;
  const parsed = new URL(to.path ?? runtime.route.path, origin);
  if (to.query !== undefined) {
    parsed.search = Object.entries(to.query)
      .flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value])
          .filter((item) => item !== undefined)
          .map((item) =>
            item === null
              ? encodeURIComponent(key)
              : `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
          ),
      )
      .join("&");
  }
  parsed.hash = to.hash ?? "";
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export async function runMiddleware(
  runtime: DmsFrontendRuntime,
  to: DmsRoute,
): Promise<DmsMiddlewareResult> {
  const declared = Array.isArray(to.meta.middleware) ? to.meta.middleware : [];
  const metadataNames = Object.keys(to.meta).filter((name) => to.meta[name]);
  const declaredHandlers = [...declared, ...metadataNames]
    .map((name) => registry.namedMiddleware.get(String(name)))
    .filter((handler): handler is DmsMiddleware => !!handler);
  const run = (handler: DmsMiddleware) => {
    const runWithContext = runtimeContexts.get(runtime);
    return runWithContext
      ? runWithContext(() => handler(to, runtime.route))
      : handler(to, runtime.route);
  };
  for (const group of middlewareGroups([
    ...registry.middleware,
    ...declaredHandlers,
  ])) {
    // A group of parallel middlewares starts together; its results apply in
    // order, as a sequence's would.
    const results = await Promise.all(group.map(run));
    const result = results.find((value) => value !== undefined);
    if (result !== undefined) return result;
  }
}

/** The middlewares in order, each run of parallel ones as one group. */
function middlewareGroups(handlers: DmsMiddleware[]): DmsMiddleware[][] {
  const groups: DmsMiddleware[][] = [];
  for (const handler of handlers) {
    const last = groups.at(-1);
    const parallel = registry.parallelMiddleware.has(handler);
    if (parallel && last && registry.parallelMiddleware.has(last[0]))
      last.push(handler);
    else groups.push([handler]);
  }
  return groups;
}

// What only a request to the server can honour: a client-side visit sends
// none and has none of these events.
const SERVER_VISIT_OPTIONS = [
  "async",
  "component",
  "data",
  "except",
  "headers",
  "method",
  "onBefore",
  "onCancel",
  "onCancelToken",
  "onProgress",
  "onStart",
  "only",
  "preserveUrl",
  "queryStringArrayFormat",
] as const satisfies readonly (keyof DmsNavigationOptions)[];

/**
 * Whether a visit to another query or hash of the page on screen can stay in
 * the browser. The page props depend on the path alone: the server would
 * answer with the same page, the site layout included. An error page is left
 * through the server, which renders the page in its place, and so is the
 * same path on another site.
 */
function staysOnPage(
  runtime: DmsFrontendRuntime,
  url: string,
  options: DmsNavigationOptions,
): boolean {
  return (
    new URL(url, currentUrl(runtime)).origin ===
      new URL(currentUrl(runtime)).origin &&
    !runtime.pageKey?.startsWith("error:") &&
    runtime.currentError.value === null &&
    SERVER_VISIT_OPTIONS.every((name) => options[name] === undefined)
  );
}

/**
 * An Inertia client-side visit: the URL and the history entry change, the
 * page keeps its props, and no request is made.
 */
function visitInBrowser(
  url: string,
  options: DmsNavigationOptions,
): Promise<void> {
  const clientVisit = options.replace
    ? inertiaRouter.replace
    : inertiaRouter.push;
  return new Promise<void>((resolve) => {
    clientVisit.call(inertiaRouter, {
      url,
      preserveScroll: options.preserveScroll ?? true,
      preserveState: options.preserveState ?? true,
      viewTransition: options.viewTransition,
      onSuccess: options.onSuccess,
      onError: options.onError,
      onFinish: (visit) => {
        (options.onFinish as ((visit: unknown) => void) | undefined)?.(visit);
        resolve();
      },
    } as Parameters<typeof inertiaRouter.push>[0]);
  });
}

export async function visit(
  runtime: DmsFrontendRuntime,
  to: RouteLocationRaw,
  options: DmsNavigationOptions = {},
): Promise<void> {
  const url = locationToUrl(runtime, to);
  const target = parseRoute(runtime, url);
  const result = await runMiddleware(runtime, target);
  if (result === false) return;
  if (result !== undefined) return visit(runtime, result, options);
  if (runtime.isServer) {
    runtime.serverRedirect = url;
    return;
  }
  // Like Vue Router, a navigation that only changes the query or hash keeps
  // the page mounted: without preserveState, Inertia remounts the page
  // component on every visit and its local state (open tabs, selection,
  // inputs) is lost.
  const samePath = target.path === runtime.route.path;
  if (samePath && staysOnPage(runtime, url, options)) {
    await visitInBrowser(url, options);
    return;
  }
  await new Promise<void>((resolve) =>
    inertiaRouter.visit(url, {
      ...options,
      preserveState: options.preserveState ?? samePath,
      preserveScroll: options.preserveScroll ?? samePath,
      onFinish: (completedVisit) => {
        options.onFinish?.(completedVisit);
        resolve();
      },
    }),
  );
}

export function useDmsRoute(pattern?: string): DmsRoute {
  const runtime = useDmsRuntime();
  runtime.currentRoutePattern = pattern;
  // A server render answers one request, whose URL the runtime was given with
  // its page, and never changes it. Inertia's page is one ref for the whole
  // process, written by each render as it starts: after an await it may hold
  // another request's URL, and while the plugins set up, the previous one's.
  if (runtime.isServer) {
    updateRoute(runtime, runtime.route.fullPath);
    return runtime.route;
  }
  const page = usePage();
  // The browser's plugins set up before Inertia has a page: until then the
  // runtime's route is the initial page's.
  if (page.url !== undefined) updateRoute(runtime, page.url);
  watch(
    () => page.url,
    (url) => updateRoute(runtime, url),
  );
  return runtime.route;
}

/**
 * Inertia's page, as `usePage()` returns it, for the request being rendered.
 * Inertia keeps a single page for the whole process, written by each server
 * render as it starts: read after an await, it may be another request's. Nuxt
 * UI's Link and route stub read this one instead (see `vite.config.ts`).
 */
export function useDmsInertiaPage(): DmsInertiaPage {
  const runtime = useDmsRuntime();
  if (runtime.isServer && runtime.inertiaPage) return runtime.inertiaPage;
  return usePage();
}

export function useDmsRouter(): DmsRouter {
  const runtime = useDmsRuntime();
  const navigate = (to: RouteLocationRaw, options?: DmsNavigationOptions) => {
    const current = currentUrl(runtime);
    return normalizeUrl(locationToUrl(runtime, to), current) ===
      normalizeUrl(current, current)
      ? Promise.resolve()
      : visit(runtime, to, options);
  };
  return {
    currentRoute: computed(() => runtime.route),
    push: navigate,
    replace: (to, options) => navigate(to, { ...options, replace: true }),
    back: () => window.history.back(),
  };
}

export function navigateDms(
  to: RouteLocationRaw,
  options?: DmsNavigationOptions,
): Promise<void> {
  return visit(useDmsRuntime(), to, options);
}
