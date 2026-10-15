import {
  Link as InertiaLink,
  type InertiaLinkProps,
  router as inertiaRouter,
  usePage,
} from "@inertiajs/vue3";
import {
  useHead as useUnhead,
  useSeoMeta as useUnheadSeoMeta,
} from "@unhead/vue";
import { defu } from "defu";
import { type FetchOptions, ofetch } from "ofetch";
import {
  type App,
  type Component,
  type ComponentPublicInstance,
  type ComputedRef,
  camelize,
  capitalize,
  computed,
  defineComponent,
  type EffectScope,
  effectScope,
  getCurrentInstance,
  getCurrentScope,
  h,
  hasInjectionContext,
  type InjectionKey,
  inject,
  isRef,
  type MaybeRefOrGetter,
  nextTick,
  onBeforeMount,
  onMounted,
  onScopeDispose,
  onServerPrefetch,
  type Plugin,
  type PropType,
  type Ref,
  reactive,
  readonly,
  ref,
  type ShallowRef,
  shallowReactive,
  shallowRef,
  toRaw,
  toValue,
  watch,
} from "vue";
import type { Composer } from "vue-i18n";
import { useI18n as useVueI18n } from "vue-i18n";
import {
  appConfigChanges,
  assignInPlace,
  mergeLayerAppConfigs,
  withAppConfigChanges,
} from "./layer-app-config";

export interface DmsPageRoute {
  displayName?: string;
  description?: string;
  fullSlug?: string;
  icon?: string;
  layoutUrl?: string;
}
export interface DmsPagePayload {
  route?: DmsPageRoute;
  componentName?: string;
  layoutUrl?: string;
  layout?: DmsPageLayout;
  [key: string]: unknown;
}
export interface DmsSharedPagePayload {
  siteLayout?: unknown;
  siteLayoutTree?: unknown;
  quickActions?: unknown;
  modules?: unknown;
  isOwner?: boolean;
}
export interface DmsLayoutDefinition {
  componentName?: string;
  options?: Record<string, unknown>;
}
export interface DmsPageLayout {
  componentName?: string;
  layout?: DmsLayoutDefinition;
  [key: string]: unknown;
}
export interface DmsPageProps {
  path: string;
  page: DmsPagePayload;
  /**
   * The site layout. An Inertia once prop: a visit carries it over from the
   * previous page until it expires, unless the server sends a newer one.
   */
  shared?: DmsSharedPagePayload;
  user?: DmsUser;
  session?: DmsSession;
  error?: DmsErrorData;
}
export interface PublicRuntimeConfig extends Record<string, unknown> {}
export interface RuntimeConfig extends Record<string, unknown> {}
export interface DmsAppConfig extends Record<string, unknown> {}
export interface DmsUser extends Record<string, unknown> {}
export interface DmsSession {
  accountId: string;
  activeTenantId?: string;
  /**
   * When the frontend server last wrote this session, in milliseconds since
   * the epoch. A page restored from history or from the prefetch cache
   * carries an older session than the one the app already holds, and does not
   * replace it.
   */
  updatedAt?: number;
}
export interface DmsRuntimeConfig extends RuntimeConfig {
  public: PublicRuntimeConfig;
}
export interface DmsModuleOptions {
  public: Record<string, unknown>;
}
export type DmsLocaleLoader = (
  locale: string,
) => Promise<Record<string, unknown>>;
export type DmsNavigationOptions = Pick<
  InertiaLinkProps,
  | "async"
  | "component"
  | "data"
  | "except"
  | "headers"
  | "method"
  | "onBefore"
  | "onCancel"
  | "onCancelToken"
  | "onError"
  | "onFinish"
  | "onProgress"
  | "onStart"
  | "onSuccess"
  | "only"
  | "preserveScroll"
  | "preserveState"
  | "preserveUrl"
  | "queryStringArrayFormat"
  | "replace"
  | "viewTransition"
>;
export interface RouteLocationObject {
  path?: string;
  query?: Record<string, unknown>;
  hash?: string;
}
export type LocationQueryValue = string | null;
export type LocationQuery = Record<
  string,
  LocationQueryValue | LocationQueryValue[]
>;
export type LocationQueryRaw = Record<
  string,
  | LocationQueryValue
  | number
  | undefined
  | (LocationQueryValue | number | undefined)[]
>;
export type RouteLocationRaw = string | RouteLocationObject;
export interface DmsRoute {
  name?: string;
  fullPath: string;
  path: string;
  query: Record<string, string>;
  params: Record<string, string>;
  meta: Record<string, unknown>;
  matched: unknown[];
}
export interface DmsRouter {
  currentRoute: Ref<DmsRoute>;
  push(to: RouteLocationRaw, options?: DmsNavigationOptions): Promise<void>;
  replace(to: RouteLocationRaw, options?: DmsNavigationOptions): Promise<void>;
  back(): void;
}
export type DmsAsyncDataStatus = "idle" | "pending" | "success" | "error";
/**
 * What a new run does with the one still in flight: `cancel` aborts it and
 * starts over, `defer` waits for it instead.
 */
export type DmsAsyncDataDedupe = "cancel" | "defer";
export interface DmsAsyncDataRefreshOptions {
  dedupe?: DmsAsyncDataDedupe;
}
export interface DmsAsyncData<T> {
  data: Ref<T | null>;
  /**
   * The key the data is loaded under, a reactive key's current one; none for
   * a call without a key.
   */
  key: Readonly<Ref<string | undefined>>;
  /**
   * `true` while `data` is still the previous key's, shown in place of the
   * default until the current key's first answer (a reactive key only).
   */
  placeholder: Readonly<Ref<boolean>>;
  /**
   * The last run's failure. It stays while the next run is in flight, and
   * goes back to `null` once a run answers.
   */
  error: Ref<unknown>;
  pending: Ref<boolean>;
  status: Ref<DmsAsyncDataStatus>;
  execute(options?: DmsAsyncDataRefreshOptions): Promise<void>;
  refresh(options?: DmsAsyncDataRefreshOptions): Promise<void>;
  /** Aborts the run in flight and puts the data back to its default. */
  clear(): void;
}
/** Usable at once, or awaited until its data is there. */
export type DmsAsyncDataResult<T> = DmsAsyncData<T> & Promise<DmsAsyncData<T>>;
export interface DmsAsyncDataContext {
  /**
   * Aborted once the result is no longer wanted: a newer run replaced it, it
   * was cleared, or no component shows its key any more.
   */
  signal: AbortSignal;
}
export type DmsAsyncDataHandler<T> = (
  context: DmsAsyncDataContext,
) => Promise<T>;
/** A key, or `null` (or `undefined`) while there is nothing to load. */
export type DmsAsyncDataKey = string | null | undefined;
/** What `useDmsData` gives of a key's data. */
export interface DmsData<T> {
  /**
   * The data loaded under the key, shared with every caller showing it:
   * `undefined` while the key has none of its own (no caller loaded it yet,
   * or it shows the previous key's data meanwhile). Assigning it replaces the
   * key's data; a key nobody loaded keeps none.
   */
  data: Ref<T | undefined>;
}
/** What `transform` knows of the run whose result it transforms. */
export interface DmsAsyncDataTransformContext {
  /** The key the data is loaded under; none for a call without a key. */
  key: string | undefined;
}
/** What `useDmsFetch`'s `transform` knows of the request it answers. */
export interface DmsFetchTransformContext extends DmsAsyncDataTransformContext {
  /**
   * The URL requested, as given (before the base URL and the query), even
   * when a reactive URL changed since.
   */
  url: string;
}
/**
 * The request options a ref or a getter may stand for: read again for each
 * request, and part of the key the response is shared under.
 */
type DmsFetchRequestSources = "method" | "query" | "params" | "body";
export interface UseAsyncDataOptions<T> {
  default?: () => T;
  /** `false` waits for `execute()` (a dialog, a drawer) before the first run. */
  immediate?: boolean;
  /**
   * A client navigation does not wait for the data. A server render still
   * does: its HTML shows the data, and the browser takes it over.
   */
  lazy?: boolean;
  /** `false` leaves the data to the browser: the server renders the default. */
  server?: boolean;
  watch?: false | unknown[];
  transform?: (
    value: unknown,
    context: DmsAsyncDataTransformContext,
  ) => T | Promise<T>;
  pick?: string[];
  /**
   * `true` tracks changes inside the value too. By default only the
   * replacement of the whole value triggers, as in Nuxt 4.
   */
  deep?: boolean;
  dedupe?: DmsAsyncDataDedupe;
  /**
   * `false` leaves the data out of `refreshDmsPageData()`, which reads again
   * the data of the components on screen once the page changed (a save, a
   * realtime event).
   */
  refreshOnPageRefresh?: boolean;
  /**
   * Reads again every this many milliseconds, in the browser, while the
   * caller shows the data and the page is visible. A ref or a getter changes
   * the interval as it changes; `0`, `null` or `undefined` stops the polling
   * until it has a value again. A call outside a component (a plugin, a
   * callback) polls for as long as the application runs.
   */
  refreshInterval?: MaybeRefOrGetter<number | null | undefined>;
}
/**
 * `useDmsFetch`'s options: ofetch's request options, of which the method, the
 * query, the params and the body may be refs or getters, and the async data
 * options.
 */
export interface UseFetchOptions<T>
  extends
    Omit<FetchOptions, DmsFetchRequestSources>,
    Omit<UseAsyncDataOptions<T>, "transform"> {
  /**
   * The key the response is shared and transferred under, in place of the
   * one the request gives: its method, base URL, URL, query and body. A ref
   * or a getter moves the caller to the data of each key it takes; `null` or
   * `undefined` requests nothing until it has a value.
   */
  key?: MaybeRefOrGetter<DmsAsyncDataKey>;
  method?: MaybeRefOrGetter<FetchOptions["method"]>;
  query?: MaybeRefOrGetter<FetchOptions["query"]>;
  params?: MaybeRefOrGetter<FetchOptions["params"]>;
  body?: MaybeRefOrGetter<FetchOptions["body"]>;
  transform?: (
    value: unknown,
    context: DmsFetchTransformContext,
  ) => T | Promise<T>;
  /** Replaces the fetch function; it receives the run's signal. */
  $fetch?: typeof ofetch;
}
export interface DmsErrorData {
  statusCode?: number;
  statusMessage?: string;
  message?: string;
  data?: unknown;
  fatal?: boolean;
}
/** What a server render hands the browser along with its HTML. */
export interface DmsPayload {
  data: Record<string, unknown>;
  errors: Record<string, DmsErrorData>;
  state: Record<string, unknown>;
}
export interface DmsStateOptions {
  /**
   * Hands the server's value to the browser, which then starts from it
   * instead of calling `init` again. Never for tokens or secrets: the value
   * is written into the page.
   */
  transfer?: boolean;
}
export interface DmsUserSession<TUser = DmsUser, TSession = DmsSession> {
  user: Ref<TUser | null>;
  session: Ref<TSession | null>;
  loggedIn: Ref<boolean>;
  fetch(): Promise<void>;
  clear(): Promise<void>;
}
export interface DmsCookieOptions<T> {
  default?: () => T;
  maxAge?: number;
  path?: string;
  sameSite?: "strict" | "lax" | "none";
  secure?: boolean;
}
type DmsLinkPrefetchMode = "mount" | "hover" | "click";
type DmsLinkPrefetch = boolean | DmsLinkPrefetchMode | DmsLinkPrefetchMode[];
export interface DmsAppContext {
  provide<T>(key: string, value: T): void;
  vueApp: App;
  runWithContext<T>(callback: () => T): T;
  hook(name: string, callback: () => void | Promise<void>): void;
  $i18n: DmsI18n;
}
export interface DmsLocale {
  code: string;
  name?: string;
}
export type DmsI18n = Composer & {
  locales: ComputedRef<DmsLocale[]>;
  setLocale(locale: string): Promise<void>;
};
export type DmsPluginSetup = (context: DmsAppContext) => void | Promise<void>;
export interface DmsMiddlewareRegistrationOptions {
  global?: boolean;
  /**
   * Runs at the same time as the parallel middlewares next to it, for one
   * that reads nothing another middleware sets (a check against the backend,
   * say). Their results still apply in registration order: the first that
   * redirects or aborts wins, and the next middlewares wait for all of them.
   */
  parallel?: boolean;
}
export interface DmsPluginRegistrationOptions {
  clientOnly?: boolean;
}
export type DmsComponentPreloader = () => Promise<unknown>;
export interface DmsComponentRegistrationOptions {
  /**
   * Registers the component under `name` as given, without the module's
   * `componentPrefix`: the way to replace a component another module
   * registers, from a module of higher priority. Defaults to `true`.
   */
  prefix?: boolean;
}
export interface DmsFrontendSdk {
  options: DmsModuleOptions;
  registerComponent(
    name: string,
    component: Component,
    options?: DmsComponentRegistrationOptions,
  ): void;
  registerPage(
    name: string,
    component: Component,
    preload?: DmsComponentPreloader,
  ): void;
  registerDynamicPage(
    name: string,
    component: Component,
    preload?: DmsComponentPreloader,
  ): void;
  registerLayout(
    name: string,
    component: Component,
    preload?: DmsComponentPreloader,
  ): void;
  registerErrorPage(
    component: Component,
    preload?: DmsComponentPreloader,
  ): void;
  registerPlugin(
    setup: DmsPluginSetup,
    options?: DmsPluginRegistrationOptions,
  ): void;
  registerMiddleware(
    name: string,
    handler: DmsMiddleware,
    options?: DmsMiddlewareRegistrationOptions,
  ): void;
  /**
   * Sends a page visit the backend refuses with a typed 403 (its body is
   * `code`) to `path` instead of the error page. The server answers with the
   * redirect before anything renders, so a reload lands on `path` directly.
   */
  registerAccessRedirect(code: string, path: string): void;
  provide<T>(key: string | InjectionKey<T>, value: T): void;
  use(plugin: Plugin): void;
}
export interface DmsFrontendModule {
  /**
   * Put in front of the name of every component the module registers, so
   * the components of two modules never collide: with `"Acme"`,
   * `registerComponent("Banner", ...)` registers `AcmeBanner`, the name the
   * backend sends and templates use.
   */
  componentPrefix?: string;
  setup(sdk: DmsFrontendSdk): void | Promise<void>;
}
export interface DmsFrontendModuleRegistration {
  /** The module's manifest name, which collision warnings name it by. */
  name?: string;
  module: DmsFrontendModule;
  options: DmsModuleOptions;
}
/** A layer's `app/app.config.ts`, as `app-configs.generated.ts` lists them. */
export interface DmsLayerAppConfig {
  /** The id of the frontend module the layer belongs to. */
  module: string;
  config: Record<string, unknown>;
}
// Async middleware without a redirect naturally infers Promise<void>.
// biome-ignore lint/suspicious/noConfusingVoidType: preserve that valid handler signature.
export type DmsMiddlewareResult = void | false | RouteLocationRaw;
export type DmsMiddleware = (
  to: DmsRoute,
  from: DmsRoute,
) => DmsMiddlewareResult | Promise<DmsMiddlewareResult>;
export type DmsRuntimeHook = (...args: unknown[]) => void | Promise<void>;
export interface DmsRuntimeHooks {
  hook(name: string, callback: DmsRuntimeHook): () => void;
  callHook(name: string, ...args: unknown[]): Promise<void>;
}

interface DmsComponentRegistration {
  name: string;
  component: Component;
  /** The registering module, for a collision warning. */
  module?: string;
  /** Registered without the module's prefix, to replace another module's. */
  unprefixed?: boolean;
}

interface DmsFrontendEntry {
  component: Component;
  preload?: DmsComponentPreloader;
}

interface DmsAsyncComponent {
  __asyncLoader?: DmsComponentPreloader;
}

interface DmsPluginRegistration {
  setup: DmsPluginSetup;
  clientOnly: boolean;
}

/**
 * What the frontend modules registered through their SDK. Modules are set up
 * by descending priority, so the first one to claim a name keeps it.
 */
interface DmsFrontendRegistry {
  components: Map<string, DmsComponentRegistration>;
  pages: Map<string, DmsFrontendEntry>;
  dynamicPages: Map<string, DmsFrontendEntry>;
  layouts: Map<string, DmsFrontendEntry>;
  errorPage?: DmsFrontendEntry;
  plugins: Plugin[];
  pluginSetups: DmsPluginRegistration[];
  middleware: DmsMiddleware[];
  namedMiddleware: Map<string, DmsMiddleware>;
  /** The middlewares registered with `parallel: true`. */
  parallelMiddleware: WeakSet<DmsMiddleware>;
  accessRedirects: Map<string, string>;
  injections: Map<string | symbol, unknown>;
}

export interface DmsFrontendRuntime {
  sharedState: Map<string, Ref<unknown>>;
  /** Reactive: `useDmsData` follows a key as it appears and is dropped. */
  asyncData: Map<string, DmsAsyncData<unknown>>;
  /** The server's data, which the browser takes over once per key. */
  hydratedAsyncData: Map<string, unknown>;
  /** The server's failures, which the browser takes over once per key. */
  hydratedAsyncErrors: Map<string, DmsErrorData>;
  /** The state keys a server render hands to the browser. */
  transferredState: Set<string>;
  /**
   * Whether the browser is still hydrating the page the server rendered,
   * whose first render must match the server's HTML.
   */
  hydrating: boolean;
  /**
   * The runs a server render started outside any component, which no
   * `onServerPrefetch` waits for.
   */
  serverPrefetches: Set<Promise<void>>;
  /** The runs in flight, which a server render aborts once it is over. */
  asyncDataRuns: Set<AbortController>;
  /** The data some component or caller shows: `refreshDmsPageData`'s. */
  boundAsyncData: Set<{ pageRefresh(): Promise<void> | undefined }>;
  /** Orders the data no caller shows, the least recently shown first. */
  asyncDataClock: number;
  /**
   * The account and workspace the keys belong to (`setDmsAsyncDataScope`):
   * the same key of another scope is another entry.
   */
  asyncDataScope?: string;
  /**
   * Runs an async data handler; a server render marks the requests it makes
   * as transferred (see `inAsyncDataHandler`).
   */
  runAsyncDataHandler?: <R>(run: () => R) => R;
  /** Whether the code running is an async data handler's. */
  inAsyncDataHandler?: () => boolean;
  /** Whether to warn about what a development render does wrong. */
  devWarnings?: boolean;
  runtimeHooks: Map<string, DmsRuntimeHook[]>;
  serverFetch?: typeof ofetch;
  currentError: Ref<Error | null>;
  route: DmsRoute;
  currentRoutePattern?: string;
  appContext?: DmsAppContext;
  isServer: boolean;
  serverRedirect?: string;
  pendingNavigation?: Promise<void>;
  hasNavigationListener: boolean;
  /** Whether the page `<Suspense>` waits on the page being navigated to. */
  pageLoading: Ref<boolean>;
  /** The site layout last copied into the state, as the page props hold it. */
  appliedShared?: DmsSharedPagePayload;
  /** Whether Inertia is putting back a page from the browser history. */
  restoringHistory?: boolean;
  /**
   * Identifies the page on screen (its path, or the error page shown at that
   * path), whose meta `route.meta` holds.
   */
  pageKey?: string;
  /** The `Cookie` header of the request a server runtime renders. */
  requestCookies?: string;
  /**
   * Owns the effects plugins create while they set up. A server render stops
   * it once done: nothing else would, since a server app is never unmounted.
   */
  scope: EffectScope;
  /** The Inertia page a server runtime renders: see `useDmsInertiaPage`. */
  inertiaPage?: DmsInertiaPage;
}

/** Inertia's page, as `usePage()` returns it. */
export type DmsInertiaPage = ReturnType<typeof usePage>;

/** Creates the empty registry one setup of the frontend modules fills. */
function createDmsFrontendRegistry(): DmsFrontendRegistry {
  return {
    components: new Map(),
    pages: new Map(),
    dynamicPages: new Map(),
    layouts: new Map(),
    plugins: [],
    pluginSetups: [],
    middleware: [],
    namedMiddleware: new Map(),
    parallelMiddleware: new WeakSet(),
    accessRedirects: new Map(),
    injections: new Map(),
  };
}

// Replaced, never refilled, by each setup of the modules: see
// `setupFrontendModules`.
let registry = createDmsFrontendRegistry();
const runtimeConfig = ref<DmsRuntimeConfig>({
  public: {},
} as DmsRuntimeConfig);
const appConfig = ref<Record<string, unknown>>({});
// What the last setup of the modules changed in the layers' app configs, which
// a development update of those configs keeps: see `updateDmsAppConfig`.
let appConfigSetupChanges: Record<string, unknown> = {};
const DMS_RUNTIME_KEY: InjectionKey<DmsFrontendRuntime> = Symbol("dms-runtime");
type DmsRuntimeContext = DmsAppContext["runWithContext"];
const runtimeContexts = new WeakMap<DmsFrontendRuntime, DmsRuntimeContext>();
let serverRuntimeResolver: (() => DmsFrontendRuntime | undefined) | undefined;
let browserRuntime: DmsFrontendRuntime | undefined;

/** Creates mutable runtime state owned by one Vue application. */
export function createDmsFrontendRuntime(
  serverFetch?: typeof ofetch,
  hydratedAsyncData?: Record<string, unknown>,
  isServer = false,
  requestCookies?: string,
): DmsFrontendRuntime {
  const runtime: DmsFrontendRuntime = {
    requestCookies,
    sharedState: new Map(),
    asyncData: shallowReactive(new Map()),
    hydratedAsyncData: new Map(Object.entries(hydratedAsyncData ?? {})),
    hydratedAsyncErrors: new Map(),
    transferredState: new Set(),
    // A browser handed the server's data, even none, hydrates its HTML.
    hydrating: !isServer && hydratedAsyncData !== undefined,
    serverPrefetches: new Set(),
    asyncDataRuns: new Set(),
    boundAsyncData: new Set(),
    asyncDataClock: 0,
    runtimeHooks: new Map(),
    serverFetch,
    isServer,
    currentError: ref<Error | null>(null),
    route: reactive<DmsRoute>({
      fullPath: "/",
      path: "/",
      query: {},
      params: {},
      meta: {},
      matched: [],
    }),
    hasNavigationListener: false,
    pageLoading: ref(false),
    scope: effectScope(true),
  };
  // A server render stops its scope once it has answered: whatever it still
  // fetches then would reach nobody.
  runtime.scope.run(() =>
    onScopeDispose(() => {
      for (const run of runtime.asyncDataRuns) run.abort();
    }),
  );
  return runtime;
}

/** Makes a runtime available before application plugins are installed. */
export function provideDmsFrontendRuntime(
  app: App,
  runtime: DmsFrontendRuntime,
): void {
  app.provide(DMS_RUNTIME_KEY, runtime);
  runtimeContexts.set(runtime, (callback) => app.runWithContext(callback));
  if (typeof window !== "undefined") browserRuntime = runtime;
}

/** Registers the request-local runtime resolver used by the SSR entry point. */
export function setDmsServerRuntimeResolver(
  resolver: () => DmsFrontendRuntime | undefined,
): void {
  serverRuntimeResolver = resolver;
}

function useDmsRuntime(): DmsFrontendRuntime {
  const instance = getCurrentInstance();
  const provided = instance?.appContext.provides[DMS_RUNTIME_KEY as symbol] as
    | DmsFrontendRuntime
    | undefined;
  if (provided) return provided;
  const contextual = hasInjectionContext()
    ? inject(DMS_RUNTIME_KEY, undefined)
    : undefined;
  if (contextual) return contextual;
  if (typeof window !== "undefined" && browserRuntime) return browserRuntime;
  const serverRuntime = serverRuntimeResolver?.();
  if (serverRuntime) return serverRuntime;
  throw new Error("DMS runtime is unavailable outside a Vue application");
}

/** Returns lifecycle hooks isolated to the current application runtime. */
export function useDmsRuntimeHooks(): DmsRuntimeHooks {
  const runtime = useDmsRuntime();
  return {
    hook(name, callback) {
      runtime.runtimeHooks.set(name, [
        ...(runtime.runtimeHooks.get(name) ?? []),
        callback,
      ]);
      return () =>
        runtime.runtimeHooks.set(
          name,
          (runtime.runtimeHooks.get(name) ?? []).filter(
            (entry) => entry !== callback,
          ),
        );
    },
    async callHook(name, ...args) {
      for (const callback of runtime.runtimeHooks.get(name) ?? [])
        await callback(...args);
    },
  };
}

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
function updateRoute(runtime: DmsFrontendRuntime, url: string): void {
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

function locationToUrl(
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

async function runMiddleware(
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

async function visit(
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

/**
 * The options of a request a runtime makes. A server render does not retry a
 * failed read, as ofetch would once: the page waits for it, and a backend
 * failing once mostly fails twice. A browser keeps ofetch's retries, and a
 * caller that names its own keeps them everywhere.
 */
function runtimeFetchOptions(
  runtime: DmsFrontendRuntime,
  options: FetchOptions,
): FetchOptions {
  return runtime.isServer && options.retry === undefined
    ? { ...options, retry: 0 }
    : options;
}

const warnedServerReads = new Set<string>();

/**
 * Warns, in a development server render, about a backend read no async data
 * handler makes: an immediate watcher's, a setup's own `await $fetch`. The
 * server waits for it, but the page carries none of it, so the browser reads
 * it again and may hydrate with other data.
 */
function warnUntransferredRead(
  runtime: DmsFrontendRuntime,
  request: string,
): void {
  if (
    !runtime.isServer ||
    !runtime.devWarnings ||
    !runtime.inAsyncDataHandler ||
    runtime.inAsyncDataHandler() ||
    warnedServerReads.has(request)
  )
    return;
  warnedServerReads.add(request);
  console.warn(
    `DMS: ${request} was read during a server render outside useDmsFetch and useDmsAsyncData ` +
      "(an immediate watcher, a setup's own await): the page does not carry the answer, " +
      "so the browser reads it again. Load it with useDmsFetch or useDmsAsyncData, " +
      "or leave it to the browser (server: false, onMounted).",
  );
}

function createDmsFetch(defaults: FetchOptions = {}): typeof ofetch {
  const execute = (request: string, options?: FetchOptions) => {
    const runtime = useDmsRuntime();
    warnUntransferredRead(runtime, request);
    return (runtime.serverFetch ?? ofetch)(
      request,
      runtimeFetchOptions(runtime, { ...defaults, ...options }),
    );
  };
  return Object.assign(execute, {
    create: (options: FetchOptions) =>
      createDmsFetch({ ...defaults, ...options }),
    native: ofetch.native,
    raw: ofetch.raw,
  }) as typeof ofetch;
}

export const $fetch = createDmsFetch();

function pickValue<T>(value: unknown, keys?: string[]): T {
  if (!keys || typeof value !== "object" || value === null) return value as T;
  return Object.fromEntries(
    keys
      .filter((key) => key in value)
      .map((key) => [key, Reflect.get(value, key)]),
  ) as T;
}

/** JSON with sorted keys, or nothing for a value JSON cannot stand for. */
function stableJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return "null";
  if (value instanceof Date) return JSON.stringify(value);
  if (typeof value !== "object")
    return ["string", "number", "boolean"].includes(typeof value)
      ? JSON.stringify(value)
      : undefined;
  if (Array.isArray(value)) {
    const items = value.map(stableJson);
    return items.includes(undefined) ? undefined : `[${items.join(",")}]`;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((name) => record[name] !== undefined)
    .sort()
    .map((name) => {
      const member = stableJson(record[name]);
      return member === undefined
        ? undefined
        : `${JSON.stringify(name)}:${member}`;
    });
  return members.includes(undefined) ? undefined : `{${members.join(",")}}`;
}

const FETCH_KEY_PREFIX = "$dmsfetch:";
const DEFAULT_FETCH_METHOD = "GET";

// cyrb53's mixing constants, with its two 32-bit lanes both kept: a 64-bit
// digest, as short as Nuxt's keys and as unlikely to collide within a page.
const HASH_SEEDS = [0xdeadbeef, 0x41c6ce57];
const HASH_MULTIPLIERS = [2654435761, 1597334677];
const HASH_FINALIZERS = [2246822507, 3266489909];
const HASH_SHIFTS = [16, 13];
const HASH_RADIX = 36;
const HASH_LANE_LENGTH = 7;

/**
 * A short digest of a text, the same in a server and in a browser: pure
 * JavaScript, so no `node:crypto` reaches a browser bundle.
 */
function hashText(text: string): string {
  let [first, second] = HASH_SEEDS;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first = Math.imul(first ^ code, HASH_MULTIPLIERS[0]);
    second = Math.imul(second ^ code, HASH_MULTIPLIERS[1]);
  }
  first = Math.imul(first ^ (first >>> HASH_SHIFTS[0]), HASH_FINALIZERS[0]);
  first ^= Math.imul(second ^ (second >>> HASH_SHIFTS[1]), HASH_FINALIZERS[1]);
  second = Math.imul(second ^ (second >>> HASH_SHIFTS[0]), HASH_FINALIZERS[0]);
  second ^= Math.imul(first ^ (first >>> HASH_SHIFTS[1]), HASH_FINALIZERS[1]);
  return [second, first]
    .map((lane) =>
      (lane >>> 0).toString(HASH_RADIX).padStart(HASH_LANE_LENGTH, "0"),
    )
    .join("");
}

/**
 * The key a request's response is shared and transferred under: a digest of
 * its method, base URL, URL, query and params, and body, the headers aside. A
 * server render writes the key into its HTML, which must not show the URL, a
 * token in its query or a body. A body only a request can read, such as a
 * FormData, gives none.
 */
function requestKey(url: string, options: FetchOptions): string | undefined {
  // ofetch sends the params and the query together, the query winning.
  const query =
    options.query || options.params
      ? { ...options.params, ...options.query }
      : null;
  const request = stableJson([
    (options.method ?? DEFAULT_FETCH_METHOD).toUpperCase(),
    options.baseURL ?? "",
    url,
    query,
    options.body ?? null,
  ]);
  return request === undefined
    ? undefined
    : `${FETCH_KEY_PREFIX}${hashText(request)}`;
}

/** The parts of a request its key is computed from. */
export type DmsRequestKeyOptions = Pick<
  FetchOptions,
  "method" | "baseURL" | "query" | "params" | "body"
>;

/**
 * The key `useDmsFetch` loads a request's response under, without the scope
 * (`setDmsAsyncDataScope`): what `refreshDmsData(keys)` takes, and what a
 * test compares with the keys it finds. `undefined` for a body only a
 * request can read, such as a FormData.
 *
 * @param url The URL as given to `useDmsFetch`, before the base URL and the query
 * @param options The method, base URL, query, params and body of the request
 */
export function dmsRequestKey(
  url: string,
  options: DmsRequestKeyOptions = {},
): string | undefined {
  return requestKey(url, options);
}

/** A URL to request, or nothing to request while it is null or undefined. */
type DmsFetchRequest = string | null | undefined;

function isReactiveSource(value: unknown): boolean {
  return isRef(value) || typeof value === "function";
}

/** The options given, without the ones left undefined. */
function definedOptions(options: FetchOptions): FetchOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as FetchOptions;
}

/**
 * Fetches a URL as `useDmsAsyncData` loads its data, under the key of the
 * request, so that the callers of one request share it and a server render
 * transfers it. A ref or a getter for the URL, the method, the query, the
 * params or the body moves the caller to the key of each request; a URL that
 * is null or undefined requests nothing.
 */
export function useDmsFetch<T>(
  request: MaybeRefOrGetter<DmsFetchRequest>,
  options: UseFetchOptions<T> = {},
): DmsAsyncDataResult<T> {
  const runtime = useDmsRuntime();
  const {
    key,
    immediate,
    lazy,
    server,
    watch: sources,
    default: fallback,
    transform,
    pick,
    deep,
    dedupe,
    refreshOnPageRefresh,
    refreshInterval,
    $fetch: fetcher,
    method,
    query,
    params,
    body,
    ...fixedOptions
  } = options;
  const url = () => toValue(request);
  const requestOptions = (): FetchOptions =>
    definedOptions({
      ...fixedOptions,
      method: toValue(method),
      query: toValue(query),
      params: toValue(params),
      body: toValue(body),
    });
  // A `$fetch` of the caller's own applies its own retries. The transform
  // runs here, where the request a response answers is known: a reactive URL
  // may have changed since it was sent.
  const handler: DmsAsyncDataHandler<T> = async ({ signal }) => {
    const target = url() as string;
    const sent = requestOptions();
    const runKey =
      key === undefined
        ? requestKey(target, sent)
        : (toValue(key) ?? undefined);
    const value: unknown = await (fetcher
      ? fetcher(target, { ...sent, signal })
      : (runtime.serverFetch ?? ofetch)(
          target,
          runtimeFetchOptions(runtime, { ...sent, signal }),
        ));
    if (!transform) return value as T;
    return transform(value, { key: runKey, url: target });
  };
  const asyncOptions: UseAsyncDataOptions<T> = {
    immediate,
    lazy,
    server,
    watch: sources,
    default: fallback,
    pick,
    deep,
    dedupe,
    refreshOnPageRefresh,
    refreshInterval,
  };
  const reactiveSources = [request, method, query, params, body].filter(
    isReactiveSource,
  );
  const isReactive = reactiveSources.length > 0;
  // The request gives its key, which follows the request as it changes.
  const derived = (): string | null | undefined => {
    const target = url();
    return target == null ? null : requestKey(target, requestOptions());
  };
  if (key === undefined && derived() !== undefined)
    return useDmsAsyncData(
      isReactive ? derived : derived(),
      handler,
      asyncOptions,
    );
  // The key the caller names, or none for a body without one, stays put while
  // the request changes: the request is watched instead.
  const watched =
    isReactive && sources !== false
      ? [...reactiveSources, ...(sources ?? [])]
      : sources;
  if (key === undefined)
    return useDmsAsyncData(handler, undefined, {
      ...asyncOptions,
      watch: watched,
    });
  const named = () => (url() == null ? null : toValue(key));
  const followsKey = isReactiveSource(request) || isReactiveSource(key);
  return useDmsAsyncData(followsKey ? named : named(), handler, {
    ...asyncOptions,
    watch: watched,
  });
}

interface AsyncDataBinding<T> {
  handler: DmsAsyncDataHandler<T>;
  options: UseAsyncDataOptions<T>;
}

interface AsyncDataRun {
  promise: Promise<void>;
  controller: AbortController;
}

interface AsyncDataBindingHandle {
  unbind(): void;
}

/** What a key holds before any run of the browser's own. */
interface AsyncDataInitialState<T> {
  data: T | null;
  error: unknown;
  status: DmsAsyncDataStatus;
}

/** What the components showing one key share: its data and its runs. */
interface AsyncDataEntry<T> {
  result: DmsAsyncData<T>;
  bind(binding: AsyncDataBinding<T>): AsyncDataBindingHandle;
  /** A run: the one in flight, or a new one. */
  load(): Promise<void>;
  /** The first run, once the current turn is over. */
  schedule(): void;
  /** Resolves once no run is in flight, including the runs that replace it. */
  settled(): Promise<void>;
  unused(): boolean;
  /** When a caller last stopped showing the data (`asyncDataClock`). */
  lastShown(): number;
  running(): boolean;
  /** `refreshDmsPageData`'s run, for data a caller shows and opted into. */
  pageRefresh(): Promise<void> | undefined;
  /**
   * Holds the server's state back, as pending, until the next turn or
   * `adoptNow`, whichever comes first.
   */
  adoptLater(state: AsyncDataInitialState<T>): void;
  adoptNow(): void;
  /** Resolves once the state held back is adopted; nothing when none is. */
  adoption(): Promise<void> | undefined;
}

const DEFAULT_DEDUPE: DmsAsyncDataDedupe = "cancel";
/**
 * How many keys no component shows any more a browser keeps, the most
 * recently shown, for a return to them to show their data at once.
 */
const MAX_UNUSED_ASYNC_DATA = 50;

const asyncDataEntries = new WeakMap<
  DmsAsyncData<unknown>,
  AsyncDataEntry<unknown>
>();

function createAsyncDataEntry<T>(
  runtime: DmsFrontendRuntime,
  key: string | undefined,
  initial: AsyncDataInitialState<T>,
  deep: boolean,
): AsyncDataEntry<T> {
  const data = (
    deep ? ref(initial.data) : shallowRef(initial.data)
  ) as Ref<T | null>;
  const error = ref<unknown>(initial.error);
  const status = ref<DmsAsyncDataStatus>(initial.status);
  const pending = computed(() => status.value === "pending");
  const bindings: AsyncDataBinding<T>[] = [];
  let run: AsyncDataRun | undefined;
  let scheduled: Promise<void> | undefined;
  let heldBack: AsyncDataInitialState<T> | undefined;
  let adoption: Promise<void> | undefined;
  let lastShown = 0;
  const adoptNow = () => {
    if (!heldBack) return;
    data.value = heldBack.data;
    error.value = heldBack.error;
    status.value = heldBack.status;
    heldBack = undefined;
  };
  const handle = (binding: AsyncDataBinding<T>, signal: AbortSignal) => {
    const call = () => binding.handler({ signal });
    return runtime.runAsyncDataHandler
      ? runtime.runAsyncDataHandler(call)
      : call();
  };
  const start = (binding: AsyncDataBinding<T>): Promise<void> => {
    heldBack = undefined;
    run?.controller.abort();
    const controller = new AbortController();
    const current: AsyncDataRun = { controller, promise: Promise.resolve() };
    run = current;
    runtime.asyncDataRuns.add(controller);
    // The last failure stays until this run answers, as in Nuxt.
    status.value = "pending";
    // A run another one replaced, or that nobody waits for any more, settles
    // nothing, even when its handler ignores the signal.
    current.promise = (async () => {
      try {
        const value = await handle(binding, controller.signal);
        const transformed = binding.options.transform
          ? await binding.options.transform(value, { key })
          : value;
        if (run !== current) return;
        data.value = pickValue<T>(transformed, binding.options.pick);
        error.value = null;
        status.value = "success";
      } catch (reason) {
        if (run !== current) return;
        // The data of the last success stays on screen next to the failure.
        error.value = reason;
        status.value = "error";
      } finally {
        runtime.asyncDataRuns.delete(controller);
        if (run === current) run = undefined;
      }
    })();
    return current.promise;
  };
  const refresh = (options: DmsAsyncDataRefreshOptions = {}) => {
    const binding = bindings.at(-1);
    if (!binding) return Promise.resolve();
    const dedupe = options.dedupe ?? binding.options.dedupe ?? DEFAULT_DEDUPE;
    return run && dedupe === "defer" ? run.promise : start(binding);
  };
  const load = (): Promise<void> => {
    if (run) return run.promise;
    const binding = bindings.at(-1);
    return binding ? start(binding) : Promise.resolve();
  };
  const result: DmsAsyncData<T> = {
    data,
    key: computed(() => key),
    placeholder: computed(() => false),
    error,
    pending,
    status,
    execute: refresh,
    refresh,
    clear() {
      heldBack = undefined;
      run?.controller.abort();
      run = undefined;
      data.value = bindings.at(-1)?.options.default?.() ?? null;
      error.value = null;
      status.value = "idle";
    },
  };
  const entry: AsyncDataEntry<T> = {
    result,
    bind(binding) {
      bindings.push(binding);
      runtime.boundAsyncData.add(entry);
      const unbind = () => {
        const index = bindings.indexOf(binding);
        if (index === -1) return;
        bindings.splice(index, 1);
        if (bindings.length > 0) return;
        lastShown = ++runtime.asyncDataClock;
        runtime.boundAsyncData.delete(entry);
        if (!run) return;
        run.controller.abort();
        run = undefined;
        // Back to what the last answer left.
        status.value =
          error.value != null
            ? "error"
            : data.value === null
              ? "idle"
              : "success";
      };
      return { unbind };
    },
    load,
    schedule() {
      // Started after the caller's turn, an explicit refresh in that turn
      // replaces this first run instead of cancelling it mid-request.
      scheduled ??= Promise.resolve().then(() => {
        scheduled = undefined;
        return load();
      });
    },
    async settled() {
      await scheduled;
      await adoption;
      while (run) await run.promise;
    },
    unused: () => bindings.length === 0,
    lastShown: () => lastShown,
    running: () => run !== undefined,
    pageRefresh() {
      const wanted = bindings.some(
        (binding) => binding.options.refreshOnPageRefresh !== false,
      );
      // Data a caller waits to `execute()` stays unread.
      if (!wanted || (status.value === "idle" && !run)) return undefined;
      return refresh();
    },
    adoptLater(state) {
      heldBack = state;
      status.value = "pending";
      adoption = Promise.resolve().then(adoptNow);
    },
    adoptNow,
    adoption: () => (heldBack ? adoption : undefined),
  };
  return entry;
}

/**
 * The state the server's render left a key in, if it rendered the key: its
 * data, or its failure next to the default it rendered.
 */
function serverAsyncDataState<T>(
  runtime: DmsFrontendRuntime,
  key: string,
  fallback: AsyncDataInitialState<T>,
): AsyncDataInitialState<T> | undefined {
  if (runtime.hydratedAsyncData.has(key))
    return {
      data: runtime.hydratedAsyncData.get(key) as T,
      error: null,
      status: "success",
    };
  const failure = runtime.hydratedAsyncErrors.get(key);
  if (!failure) return undefined;
  return { data: fallback.data, error: createError(failure), status: "error" };
}

/**
 * The key an entry is stored and transferred under: the caller's key, in
 * the runtime's scope (`setDmsAsyncDataScope`).
 */
function scopedKey(runtime: DmsFrontendRuntime, key: string): string {
  return runtime.asyncDataScope === undefined
    ? key
    : `${runtime.asyncDataScope}|${key}`;
}

function asyncDataEntry<T>(
  runtime: DmsFrontendRuntime,
  key: string | undefined,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
): AsyncDataEntry<T> {
  const stored = key === undefined ? undefined : scopedKey(runtime, key);
  const shared =
    stored === undefined ? undefined : runtime.asyncData.get(stored);
  if (shared) return asyncDataEntries.get(shared) as AsyncDataEntry<T>;
  const fallback: AsyncDataInitialState<T> = {
    data: options.default?.() ?? null,
    error: null,
    status: "idle",
  };
  const server =
    stored === undefined
      ? undefined
      : serverAsyncDataState<T>(runtime, stored, fallback);
  const entry = createAsyncDataEntry<T>(
    runtime,
    key,
    server && !inComponent ? server : fallback,
    options.deep === true,
  );
  // A component's setup saw the server's run in flight, not its result: the
  // browser holds the result back as long, see `startAsyncData`.
  if (server && inComponent) entry.adoptLater(server);
  if (stored === undefined) return entry;
  runtime.hydratedAsyncData.delete(stored);
  runtime.hydratedAsyncErrors.delete(stored);
  const result = entry.result as DmsAsyncData<unknown>;
  runtime.asyncData.set(stored, result);
  asyncDataEntries.set(result, entry as AsyncDataEntry<unknown>);
  return entry;
}

/**
 * Loads data once for every component that shows the same key, with Nuxt's
 * semantics: a server render waits for it before rendering, and transfers it,
 * whether or not the caller awaits it; `lazy` only spares client navigations
 * the wait; `server: false` leaves it to the browser.
 *
 * In the browser, data loaded before is shown at once and read again in the
 * background on each mount and each return to its key (stale while
 * revalidate), except while the page the server rendered hydrates: its data
 * is the server's, just read.
 *
 * A call without a key cannot be transferred: the server leaves it to the
 * browser, as `server: false` does, so the page hydrates with what it shows.
 */
export function useDmsAsyncData<T>(
  keyOrHandler: MaybeRefOrGetter<DmsAsyncDataKey> | DmsAsyncDataHandler<T>,
  handler?: DmsAsyncDataHandler<T>,
  callerOptions: UseAsyncDataOptions<T> = {},
): DmsAsyncDataResult<T> {
  const runtime = useDmsRuntime();
  // A call outside any scope (a plugin past its first await, a callback)
  // belongs to the application: its watchers and its polling live as long.
  if (getCurrentScope() || !runtime.scope.active)
    return createAsyncDataCall(runtime, keyOrHandler, handler, callerOptions);
  return runtime.scope.run(() =>
    createAsyncDataCall(runtime, keyOrHandler, handler, callerOptions),
  )!;
}

function createAsyncDataCall<T>(
  runtime: DmsFrontendRuntime,
  keyOrHandler: MaybeRefOrGetter<DmsAsyncDataKey> | DmsAsyncDataHandler<T>,
  handler: DmsAsyncDataHandler<T> | undefined,
  callerOptions: UseAsyncDataOptions<T>,
): DmsAsyncDataResult<T> {
  // With a handler second, the first argument is the key: a string, or a ref
  // or getter whose changes move the caller to the data of another key.
  const keySource = handler
    ? (keyOrHandler as MaybeRefOrGetter<DmsAsyncDataKey>)
    : undefined;
  const execute = handler ?? keyOrHandler;
  if (typeof execute !== "function")
    throw new Error("useDmsAsyncData requires a handler");
  const keyless = keySource === undefined;
  if (keyless && runtime.isServer && runtime.devWarnings)
    console.warn(
      "DMS: useDmsAsyncData without a key, or useDmsFetch with a body it cannot key, " +
        "is left to the browser: give it a key for the server to render it.",
    );
  const options: UseAsyncDataOptions<T> = keyless
    ? { ...callerOptions, server: false }
    : callerOptions;
  const inComponent = getCurrentInstance() !== null;
  const consumer = shallowRef(
    attachAsyncData(
      runtime,
      keyless ? undefined : (toValue(keySource) ?? null),
      execute as DmsAsyncDataHandler<T>,
      options,
      inComponent,
    ),
  );
  if (getCurrentScope()) onScopeDispose(() => consumer.value.unbind());
  if (options.watch && options.watch.length)
    refreshOnWatchedChange(consumer, options.watch);
  // Registered in the browser too, though only a server calls it: Vue makes
  // a component that prefetches an async boundary, which shifts the ids
  // `useId()` gives the components after it, and both sides must agree. It
  // waits for the key the caller is on by then, which its setup may have set.
  let prefetched = false;
  if (inComponent && options.immediate !== false && options.server !== false)
    onServerPrefetch(() => {
      prefetched = true;
      return consumer.value.entry.settled();
    });
  pollAsyncData(runtime, consumer, options);
  const { entry } = consumer.value;
  const waited = startAsyncData(runtime, entry, options, inComponent);
  const result =
    keySource == null || typeof keySource === "string"
      ? entry.result
      : followAsyncDataKey(
          runtime,
          consumer,
          keySource,
          execute as DmsAsyncDataHandler<T>,
          options,
          inComponent,
          () => !prefetched,
        );
  return Object.assign(
    Promise.resolve(waited).then(() => result),
    result,
  );
}

/**
 * Reads the data again when a watched source changes, but when the caller's
 * key moved in the same turn: the new key's own read already has the change.
 */
function refreshOnWatchedChange<T>(
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  sources: unknown[],
): void {
  let moved = false;
  watch(
    () => consumer.value.entry,
    () => {
      moved = true;
      void nextTick(() => {
        moved = false;
      });
    },
    { flush: "sync" },
  );
  watch(sources as never[], () => {
    if (!moved) void consumer.value.entry.result.refresh();
  });
}

/**
 * Reads the data again every `refreshInterval`, in the browser, following
 * the interval as it changes: none, `0` or `null` stops it.
 */
function pollAsyncData<T>(
  runtime: DmsFrontendRuntime,
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  options: UseAsyncDataOptions<T>,
): void {
  const interval = options.refreshInterval;
  if (runtime.isServer || interval === undefined) return;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };
  watch(
    () => toValue(interval),
    (period) => {
      stop();
      if (period && period > 0)
        timer = setInterval(() => pollOnce(consumer, options), period);
    },
    { immediate: true },
  );
  if (getCurrentScope()) onScopeDispose(stop);
}

function pollOnce<T>(
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  options: UseAsyncDataOptions<T>,
): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden")
    return;
  const result = consumer.value.entry.result;
  // Data a caller waits to `execute()` is not read before it is.
  if (result.status.value === "idle" && options.immediate === false) return;
  void result.refresh({ dedupe: "defer" });
}

/**
 * Starts the run a caller needs, where its side needs it, and returns what
 * awaiting the call waits for.
 */
function startAsyncData<T>(
  runtime: DmsFrontendRuntime,
  entry: AsyncDataEntry<T>,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
): Promise<void> | undefined {
  const immediate = options.immediate !== false;
  const onServer = options.server !== false;
  const idle = entry.result.status.value === "idle";
  if (runtime.isServer) {
    if (!immediate || !onServer) return undefined;
    if (idle && options.lazy) entry.schedule();
    else if (idle) void entry.load();
    const settled = entry.settled();
    if (!inComponent) runtime.serverPrefetches.add(settled);
    return settled;
  }
  // The server's render had the data once the setup awaited it, and before
  // the component rendered: handed over at the same points, it gives what
  // the setup derives from it, and so the HTML, the same values.
  const adoption = entry.adoption();
  if (adoption) {
    if (inComponent) onBeforeMount(entry.adoptNow);
    return adoption;
  }
  if (!immediate) return undefined;
  const waitForData = () =>
    !options.lazy && entry.result.data.value === null
      ? entry.settled()
      : undefined;
  if (entry.running()) return waitForData();
  if (!idle) {
    // Loaded before: shown at once and read again in the background, except
    // while the page the server rendered hydrates with the server's data.
    if (!runtime.hydrating) void entry.load();
    return waitForData();
  }
  // The server rendered the default in place of this data: the browser's
  // first render must show it too, before the request leaves.
  if (runtime.hydrating && (options.lazy || !onServer)) {
    if (inComponent) onMounted(() => void entry.load());
    else entry.schedule();
  } else if (options.lazy) entry.schedule();
  else void entry.load();
  return !options.lazy && entry.result.pending.value
    ? entry.settled()
    : undefined;
}

interface AsyncDataConsumer<T> extends AsyncDataBindingHandle {
  entry: AsyncDataEntry<T>;
  /** Whether no other component showed the key when this one came. */
  alone: boolean;
}

/**
 * Binds a caller to the data of its key. A `null` key has no data to load:
 * the caller holds its default, and nothing runs until it has a key.
 */
function attachAsyncData<T>(
  runtime: DmsFrontendRuntime,
  key: string | null | undefined,
  handler: DmsAsyncDataHandler<T>,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
): AsyncDataConsumer<T> {
  const entry = asyncDataEntry(runtime, key ?? undefined, options, inComponent);
  const alone = entry.unused();
  if (key === null) return { entry, alone, unbind() {} };
  return { entry, alone, ...entry.bind({ handler, options }) };
}

/**
 * Moves a caller to the data of each key its reactive key takes, and returns
 * refs that follow it there. Until the new key's data is in, the previous
 * data stays on screen rather than the default flashing in its place: the
 * caller's refs show it, and `placeholder` says so, while the new key's own
 * data stays its own, so a run that fails or that a switch away aborts never
 * leaves it another key's data. A key loaded before shows its own data at
 * once, and is read again in the background.
 *
 * A new key is read where the first one would have been. A server reads it
 * neither for `server: false` nor for `immediate: false`, and otherwise only
 * while its render still waits for the caller: until the prefetch of the
 * caller's component, or, outside a component, as a call made then. Past
 * that point the server renders the default and the browser reads the key. A
 * browser hydrating the server's HTML reads a key the server did not render
 * once the component is mounted, so that its first render matches the HTML.
 */
function followAsyncDataKey<T>(
  runtime: DmsFrontendRuntime,
  consumer: ShallowRef<AsyncDataConsumer<T>>,
  keySource: MaybeRefOrGetter<DmsAsyncDataKey>,
  handler: DmsAsyncDataHandler<T>,
  options: UseAsyncDataOptions<T>,
  inComponent: boolean,
  serverWaits: () => boolean,
): DmsAsyncData<T> {
  // A read held back until the hydrating component is mounted.
  let held = false;
  let mounted = !(inComponent && runtime.hydrating);
  if (!mounted)
    onMounted(() => {
      mounted = true;
      const { entry } = consumer.value;
      if (held && entry.result.status.value === "idle") void entry.load();
      held = false;
    });
  const startOnServer = (entry: AsyncDataEntry<T>) => {
    if (
      options.server === false ||
      options.immediate === false ||
      !serverWaits()
    )
      return;
    void entry.load();
    if (!inComponent) runtime.serverPrefetches.add(entry.settled());
  };
  const current = () => consumer.value.entry.result;
  // The previous key's data, shown until the current key settles.
  const carried = shallowRef<{ value: T | null } | undefined>();
  const settled = (result: DmsAsyncData<T>) =>
    result.status.value === "success" || result.status.value === "error";
  const shownData = (): T | null => {
    const result = current();
    return carried.value && !settled(result)
      ? carried.value.value
      : result.data.value;
  };
  watch(
    () => settled(current()),
    (done) => {
      if (done) carried.value = undefined;
    },
    { flush: "sync" },
  );
  // Data written to the current key from elsewhere (`useDmsData`, another
  // caller of the key) is its own: it replaces what is carried.
  watch(
    () => [current(), current().data.value] as const,
    ([result], [previous]) => {
      if (result === previous) carried.value = undefined;
    },
    { flush: "sync" },
  );
  watch(
    () => toValue(keySource) ?? null,
    (key) => {
      const previous = current();
      const shown = shownData();
      const wasRunning = previous.pending.value;
      // Past the setup, the server's data for the new key, if it rendered
      // any, is taken over at once.
      const next = attachAsyncData(runtime, key, handler, options, false);
      const { entry } = next;
      const carry =
        next.alone && entry.result.status.value === "idle" && shown !== null;
      // Unbound first: the previous key's run, aborted, settles it, which
      // must not drop what is carried to the next key.
      consumer.value.unbind();
      consumer.value = next;
      carried.value = carry ? { value: shown } : undefined;
      held = false;
      // `watch: false` keeps the caller on the key it names, without a run.
      if (key === null || options.watch === false) return;
      if (runtime.isServer) return startOnServer(entry);
      const wanted =
        options.immediate !== false || shown !== null || wasRunning;
      if (!wanted) return;
      if (!mounted) held = true;
      else if (!inComponent && runtime.hydrating) entry.schedule();
      else void entry.load();
    },
    { flush: "sync" },
  );
  const through = <V>(read: (result: DmsAsyncData<T>) => Ref<V>): Ref<V> =>
    computed({
      get: () => read(current()).value,
      set: (value) => {
        read(current()).value = value;
      },
    });
  return {
    data: computed({
      get: shownData,
      set: (value) => {
        carried.value = undefined;
        current().data.value = value;
      },
    }),
    key: computed(() => current().key.value),
    placeholder: computed(
      () => carried.value !== undefined && !settled(current()),
    ),
    error: through((result) => result.error),
    pending: computed(() => current().pending.value),
    status: through((result) => result.status),
    execute: (refreshOptions) => current().refresh(refreshOptions),
    refresh: (refreshOptions) => current().refresh(refreshOptions),
    clear: () => {
      carried.value = undefined;
      current().clear();
    },
  };
}

export function useDmsLazyAsyncData<T>(
  keyOrHandler: MaybeRefOrGetter<DmsAsyncDataKey> | DmsAsyncDataHandler<T>,
  handler?: DmsAsyncDataHandler<T>,
  options: UseAsyncDataOptions<T> = {},
): DmsAsyncDataResult<T> {
  return useDmsAsyncData(keyOrHandler, handler, { ...options, lazy: true });
}

/** What a paged read keeps under its key: the pages loaded, in order. */
export interface DmsPagedDataValue<TPage, TCursor> {
  pages: TPage[];
  /** The cursor of the page after the last one; `null` once there is none. */
  next: TCursor | null;
}
/** What a paged read's handler receives. */
export interface DmsPagedDataContext<TCursor> extends DmsAsyncDataContext {
  /** The page to read: `initialCursor` for the first one. */
  cursor: TCursor | undefined;
  /** Its position, from `0`. */
  index: number;
}
export type DmsPagedDataHandler<TPage, TCursor> = (
  context: DmsPagedDataContext<TCursor>,
) => Promise<TPage>;
export interface UseDmsPagedDataOptions<TPage, TCursor> extends Omit<
  UseAsyncDataOptions<DmsPagedDataValue<TPage, TCursor>>,
  "default" | "transform" | "pick"
> {
  /** The cursor of the page after `page`, or `null` (or `undefined`) for none. */
  nextCursor(page: TPage, pages: TPage[]): TCursor | null | undefined;
  /** The first page's cursor; none by default. */
  initialCursor?: TCursor;
}
export interface DmsPagedData<TPage, TCursor> extends DmsAsyncData<
  DmsPagedDataValue<TPage, TCursor>
> {
  /** The pages loaded so far, in order; none before the first answer. */
  pages: Readonly<Ref<TPage[]>>;
  /** Whether `loadMore()` has a page to read. */
  hasMore: Readonly<Ref<boolean>>;
  /** `true` while `loadMore()` reads its page. */
  loadingMore: Readonly<Ref<boolean>>;
  /**
   * Reads the next page and appends it under the same key. It waits for a
   * read in flight first, does nothing once there is no next page, and puts
   * a failure in `error`, keeping the pages loaded.
   */
  loadMore(): Promise<void>;
}
export type DmsPagedDataResult<TPage, TCursor> = DmsPagedData<TPage, TCursor> &
  Promise<DmsPagedData<TPage, TCursor>>;

type PagedValue<TPage, TCursor> = DmsPagedDataValue<TPage, TCursor>;

/** Reads `count` pages from the first, as long as each has a next one. */
async function readPages<TPage, TCursor>(
  handler: DmsPagedDataHandler<TPage, TCursor>,
  options: UseDmsPagedDataOptions<TPage, TCursor>,
  count: number,
  signal: AbortSignal,
): Promise<PagedValue<TPage, TCursor>> {
  const pages: TPage[] = [];
  let cursor: TCursor | undefined = options.initialCursor;
  for (let index = 0; index < count; index++) {
    const page = await handler({ cursor, index, signal });
    pages.push(page);
    const next = options.nextCursor(page, pages);
    if (next == null) return { pages, next: null };
    cursor = next;
  }
  return { pages, next: cursor ?? null };
}

/** Resolves once `result` has no run in flight. */
function untilSettled<T>(result: DmsAsyncData<T>): Promise<void> {
  if (!result.pending.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(result.pending, (pending) => {
      if (pending) return;
      stop();
      resolve();
    });
  });
}

/**
 * A list read page by page under one key: "load more", an infinite list.
 * The first page loads as `useDmsAsyncData` loads its data (a server render
 * waits for it and transfers it), and `loadMore()` appends the next one to
 * the same key, so the pages a component loaded show at once on a return to
 * it. A revalidation (a mount, `refresh()`, `refreshDmsPageData()`, the
 * polling) reads every page loaded so far again, from the first, and
 * replaces them once all are in. Put what filters the list in the key: a new
 * key starts again from its first page.
 *
 * @param key The key, or a ref or getter for it
 * @param handler Reads one page, from the cursor it receives
 * @param options `nextCursor`, `initialCursor` and the async data options
 */
export function useDmsPagedData<TPage, TCursor = unknown>(
  key: MaybeRefOrGetter<DmsAsyncDataKey>,
  handler: DmsPagedDataHandler<TPage, TCursor>,
  options: UseDmsPagedDataOptions<TPage, TCursor>,
): DmsPagedDataResult<TPage, TCursor> {
  const {
    nextCursor: _next,
    initialCursor: _initial,
    ...asyncOptions
  } = options;
  let shown: DmsAsyncData<PagedValue<TPage, TCursor>> | undefined;
  const loadedCount = () =>
    shown && !shown.placeholder.value
      ? Math.max(1, shown.data.value?.pages.length ?? 0)
      : 1;
  const call = useDmsAsyncData<PagedValue<TPage, TCursor>>(
    key,
    ({ signal }) => readPages(handler, options, loadedCount(), signal),
    asyncOptions,
  );
  shown = call;
  const result: DmsPagedData<TPage, TCursor> = Object.assign(
    {},
    call as DmsAsyncData<PagedValue<TPage, TCursor>>,
    pagedControls(call, handler, options),
  );
  return Object.assign(
    call.then(() => result),
    result,
  );
}

function pagedControls<TPage, TCursor>(
  call: DmsAsyncData<PagedValue<TPage, TCursor>>,
  handler: DmsPagedDataHandler<TPage, TCursor>,
  options: UseDmsPagedDataOptions<TPage, TCursor>,
) {
  const loadingMore = ref(false);
  let controller: AbortController | undefined;
  const abort = () => {
    controller?.abort();
    controller = undefined;
    loadingMore.value = false;
  };
  watch(call.key, abort);
  if (getCurrentScope()) onScopeDispose(abort);
  const hasMore = computed(
    () => !call.placeholder.value && (call.data.value?.next ?? null) !== null,
  );
  const loadMore = async (): Promise<void> => {
    if (call.pending.value) await untilSettled(call);
    const before = call.data.value;
    if (!before) return call.execute();
    if (before.next === null || controller) return;
    const current = new AbortController();
    controller = current;
    loadingMore.value = true;
    try {
      const page = await handler({
        cursor: before.next,
        index: before.pages.length,
        signal: current.signal,
      });
      if (controller !== current || call.data.value !== before) return;
      const pages = [...before.pages, page];
      call.data.value = {
        pages,
        next: options.nextCursor(page, pages) ?? null,
      };
    } catch (reason) {
      if (controller === current) call.error.value = reason;
    } finally {
      if (controller === current) abort();
    }
  };
  return {
    pages: computed(() => call.data.value?.pages ?? []),
    hasMore,
    loadingMore: readonly(loadingMore),
    loadMore,
  };
}

/**
 * The data another caller loads under `key`, as Nuxt's `useNuxtData`: to
 * update it in place without reading it again, from what a write answered
 * (an optimistic update) or what a realtime event says changed. It follows
 * the key in the runtime's scope (`setDmsAsyncDataScope`): `undefined` until
 * a caller loads the key, its data once there, `undefined` again once the
 * browser lets the key go (past the most recent keys it keeps) or the scope
 * changes. It does not load the key, nor keep it.
 */
export function useDmsData<T>(
  key: MaybeRefOrGetter<DmsAsyncDataKey>,
): DmsData<T> {
  const runtime = useDmsRuntime();
  const entry = () => {
    const name = toValue(key);
    const result =
      name == null
        ? undefined
        : runtime.asyncData.get(scopedKey(runtime, String(name)));
    return result && asyncDataEntries.get(result);
  };
  // A component after the caller, in the page or in its subtree, renders the
  // data the browser hydrates it with: the server waits for the caller's run
  // too. One before it has none on either side. Whether the key is there as
  // the setup runs is the same on both sides, and so are the async
  // boundaries `useId()` counts.
  const loaded = entry();
  if (loaded && getCurrentInstance()) onServerPrefetch(() => loaded.settled());
  return {
    data: computed({
      get() {
        // An entry only ever holds its own key's data: a caller showing the
        // previous key's data meanwhile keeps it in its own refs.
        return (entry()?.result.data.value ?? undefined) as T | undefined;
      },
      set(value) {
        const current = entry();
        if (!current) return;
        current.result.data.value = value ?? null;
      },
    }),
  };
}

/** Reads the data of the keys given, or of every key, again. */
export async function refreshDmsData(keys?: string | string[]): Promise<void> {
  const runtime = useDmsRuntime();
  const selected = keys
    ? (Array.isArray(keys) ? keys : [keys]).map((key) =>
        scopedKey(runtime, key),
      )
    : [...runtime.asyncData.keys()];
  await Promise.all(
    selected.map((key) => runtime.asyncData.get(key)?.refresh()),
  );
}

/**
 * Reads again the data the components on screen show, but those that opted
 * out (`refreshOnPageRefresh: false`) and those waiting for `execute()`:
 * what a page calls once something changed what it shows, after a save or
 * on a realtime event, instead of each component refreshing its own.
 */
export async function refreshDmsPageData(): Promise<void> {
  const runtime = useDmsRuntime();
  await Promise.all(
    [...runtime.boundAsyncData].map((entry) => entry.pageRefresh()),
  );
}

/**
 * Puts the keys of the async data in a scope, such as a digest of the
 * account and the workspace: the same key in another scope is another
 * entry, never the data of the previous one. Moving to another scope drops
 * the data of every key, aborting its runs; the components on screen then
 * show their default until they load again. Call it on both sides before
 * the page renders, with the same value, so the browser finds the data the
 * server transferred; the scope is written in the page with each key, so a
 * digest rather than an identifier.
 *
 * @param scope The scope, or `undefined` for none
 */
export function setDmsAsyncDataScope(scope: string | undefined): void {
  const runtime = useDmsRuntime();
  if (runtime.asyncDataScope === scope) return;
  runtime.asyncDataScope = scope;
  for (const result of runtime.asyncData.values()) result.clear();
  runtime.asyncData.clear();
}

/**
 * Drops the data no component shows any more, but the most recently shown:
 * a return to a key shows its data at once, and the data does not pile up
 * over a session.
 */
function dropUnusedAsyncData(runtime: DmsFrontendRuntime): void {
  const unused = [...runtime.asyncData]
    .map(([key, result]) => ({ key, entry: asyncDataEntries.get(result) }))
    .filter(({ entry }) => entry?.unused())
    .sort((left, right) => right.entry!.lastShown() - left.entry!.lastShown());
  for (const { key } of unused.slice(MAX_UNUSED_ASYNC_DATA))
    runtime.asyncData.delete(key);
}

export function serializeDmsAsyncData(
  runtime: DmsFrontendRuntime,
): Record<string, unknown> {
  return Object.fromEntries(
    [...runtime.asyncData.entries()]
      .filter(([, entry]) => entry.status.value === "success")
      .map(([key, entry]) => [key, toRaw(entry.data.value)]),
  );
}

const HTTP_ERROR_STATUS = { min: 400, max: 599 };
const SERVER_FAILURE_STATUS = 500;
const FETCH_ERROR_NAME = "FetchError";

/** The fields of a failure, under the names `createError` and ofetch use. */
interface DmsFailure extends DmsErrorData {
  name?: string;
  status?: number;
  statusText?: string;
}

/**
 * What of a failure a page may carry, by the rule the error page follows: an
 * HTTP failure keeps its status, status text and message, and its body if it
 * is a 4xx, anything else
 * is a server failure whose cause only reaches the server log. A fetch error
 * names the URL it requested, which on a server is the backend's own address:
 * its status text stands for it.
 */
function transferredError(key: string, reason: unknown): DmsErrorData {
  const failure = (reason ?? {}) as DmsFailure;
  const statusCode = failure.statusCode ?? failure.status;
  if (
    statusCode === undefined ||
    !Number.isInteger(statusCode) ||
    statusCode < HTTP_ERROR_STATUS.min ||
    statusCode > HTTP_ERROR_STATUS.max
  ) {
    console.error(`DMS async data "${key}" failed`, reason);
    return { statusCode: SERVER_FAILURE_STATUS };
  }
  const statusMessage = failure.statusMessage ?? failure.statusText;
  const transferred: DmsErrorData = {
    statusCode,
    statusMessage,
    message:
      failure.name === FETCH_ERROR_NAME ? statusMessage : failure.message,
  };
  // A 5xx body is the backend's own account of its failure, a stack or a
  // query at times: only a 4xx body, written for the client, is transferred.
  if (statusCode < SERVER_FAILURE_STATUS) transferred.data = failure.data;
  return transferred;
}

/**
 * What a page's error page shows of an expected failure (a 4xx or 5xx): its
 * status code, status text and message. A fetch error's message names the URL
 * it requested, on a server the backend's own address: its status text
 * stands for it.
 */
export function pageErrorData(failure: Error & DmsErrorData): DmsErrorData {
  return {
    statusCode: failure.statusCode,
    message:
      failure.name === FETCH_ERROR_NAME
        ? failure.statusMessage
        : failure.message,
    statusMessage: failure.statusMessage,
  };
}

/**
 * Everything a server render hands the browser: the data and the failures of
 * its keys, and the state keys opted into. Read as the HTML is complete.
 */
export function serializeDmsPayload(runtime: DmsFrontendRuntime): DmsPayload {
  const errors = [...runtime.asyncData.entries()]
    .filter(([, entry]) => entry.status.value === "error")
    .map(([key, entry]): [string, DmsErrorData] => [
      key,
      transferredError(key, entry.error.value),
    ]);
  const state = [...runtime.transferredState]
    .map((key): [string, unknown] => [
      key,
      toRaw(runtime.sharedState.get(key)?.value),
    ])
    .filter(([, value]) => value !== undefined);
  return {
    data: serializeDmsAsyncData(runtime),
    errors: Object.fromEntries(errors),
    state: Object.fromEntries(state),
  };
}

/** Starts a browser runtime from what the server rendered. */
export function restoreDmsPayload(
  runtime: DmsFrontendRuntime,
  payload: Partial<DmsPayload>,
): void {
  runtime.hydrating = true;
  for (const [key, value] of Object.entries(payload.data ?? {}))
    runtime.hydratedAsyncData.set(key, value);
  for (const [key, failure] of Object.entries(payload.errors ?? {}))
    runtime.hydratedAsyncErrors.set(key, failure);
  for (const [key, value] of Object.entries(payload.state ?? {}))
    runtime.sharedState.set(key, ref(value));
}

export function useDmsState<T>(
  key: string,
  init?: () => T,
  options: DmsStateOptions = {},
): Ref<T> {
  const runtime = useDmsRuntime();
  if (options.transfer) runtime.transferredState.add(key);
  if (!runtime.sharedState.has(key))
    runtime.sharedState.set(key, ref(init?.()));
  return runtime.sharedState.get(key) as Ref<T>;
}
export function useDmsRuntimeConfig(): DmsRuntimeConfig {
  return runtimeConfig.value;
}
export function useDmsAppConfig(): DmsAppConfig {
  return appConfig.value as DmsAppConfig;
}
export function defineAppConfig<T extends Record<string, unknown>>(
  config: T,
): T {
  return config;
}
export function defineDmsMiddleware(handler: DmsMiddleware): DmsMiddleware {
  return handler;
}
export function defineDmsPageMeta(meta: Record<string, unknown>): void {
  const runtime = useDmsRuntime();
  Object.assign(runtime.route.meta, meta);
  // A middleware that throws fails the page, as in Nuxt: the error page
  // shows in its place with the error's status code, which a server render
  // answers with. A redirect another navigation decided still wins.
  const navigation = runMiddleware(runtime, runtime.route)
    .then(async (result) => {
      if (result !== undefined && result !== false)
        await visit(runtime, result);
    })
    .catch((reason) => failPage(runtime, reason));
  runtime.pendingNavigation = runtime.pendingNavigation
    ? Promise.all([runtime.pendingNavigation, navigation]).then(() => undefined)
    : navigation;
  void runtime.pendingNavigation;
  // A server renders the page's subtree once its middleware is done, so the
  // state a middleware sets is the one the HTML shows and the payload carries.
  // A failure shows the error page in its place (`failPage`). Registered
  // in the browser too, where only a server calls it: both sides must agree
  // on the async boundaries `useId()` counts.
  if (getCurrentInstance())
    onServerPrefetch(() => navigation.then(ignoreSettlement, ignoreSettlement));
}
function ignoreSettlement(): void {}
/** Shows the error page in place of the page, keeping the first failure. */
function failPage(runtime: DmsFrontendRuntime, reason: unknown): void {
  runtime.currentError.value ??=
    reason instanceof Error ? reason : new Error(String(reason));
}
export function abortNavigation(): false {
  return false;
}
export const useHead = useUnhead;
export const useSeoMeta = useUnheadSeoMeta;
export function useI18n(): DmsI18n {
  return useVueI18n() as DmsI18n;
}

function shouldNavigateDmsLink(event: MouseEvent): boolean {
  const element = event.currentTarget;
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    (element instanceof HTMLAnchorElement &&
      Boolean(element.target) &&
      element.target !== "_self")
  );
}

function dmsLinkNavigationOptions(
  attributes: Record<string, unknown>,
): DmsNavigationOptions {
  const options = attributes as DmsNavigationOptions;
  return {
    async: options.async,
    component: options.component,
    data: options.data,
    except: options.except,
    headers: options.headers,
    method: options.method,
    onBefore: options.onBefore,
    onCancel: options.onCancel,
    onCancelToken: options.onCancelToken,
    onError: options.onError,
    onFinish: options.onFinish,
    onProgress: options.onProgress,
    onStart: options.onStart,
    onSuccess: options.onSuccess,
    only: options.only,
    preserveScroll: options.preserveScroll,
    preserveState: options.preserveState,
    preserveUrl: options.preserveUrl,
    queryStringArrayFormat: options.queryStringArrayFormat,
    replace: options.replace,
    viewTransition: options.viewTransition,
  };
}

export const DmsLink: Component = defineComponent({
  name: "DmsLink",
  inheritAttrs: false,
  props: {
    to: {
      type: [String, Object] as PropType<RouteLocationRaw>,
      required: true,
    },
  },
  setup(props, { attrs, slots }) {
    const runtime = useDmsRuntime();
    const prefetch = attrs.prefetch as DmsLinkPrefetch | undefined;
    const onClick = (event: MouseEvent) => {
      if (typeof attrs.onClick === "function") attrs.onClick(event);
      if (!shouldNavigateDmsLink(event)) return;
      event.preventDefault();
      void visit(runtime, props.to, dmsLinkNavigationOptions(attrs));
    };
    return (): ReturnType<typeof h> =>
      h(
        InertiaLink,
        {
          ...attrs,
          href: locationToUrl(runtime, props.to),
          onClick,
          prefetch: prefetch ?? "hover",
        },
        slots,
      );
  },
});

export const DmsClientOnly = defineComponent({
  name: "DmsClientOnly",
  setup(_, { slots }) {
    const isMounted = ref(false);
    onMounted(() => {
      isMounted.value = true;
    });
    return () =>
      isMounted.value ? slots.default?.() : (slots.fallback?.() ?? null);
  },
});

export function defineDmsPlugin(setup: DmsPluginSetup): DmsPluginSetup {
  return setup;
}
export function useDmsApp(): DmsAppContext {
  const instance = getCurrentInstance();
  const contextual = instance?.appContext.config.globalProperties
    .$dms as DmsAppContext;
  return contextual ?? (useDmsRuntime().appContext as DmsAppContext);
}

const COOKIE_STATE_PREFIX = "dms-cookie:";
// A browser tab runs one application, so its cookie refs are shared by every
// caller; a server shares them within the request it renders instead.
const browserCookieRefs = new Map<string, Ref<unknown>>();

function readCookie(
  source: string | undefined,
  name: string,
): string | undefined {
  const match = source
    ?.split(/;\s*/)
    .find((entry) => entry.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

function parseCookieValue<T>(
  stored: string | undefined,
  options: DmsCookieOptions<T>,
): T {
  if (stored === undefined) return (options.default?.() ?? null) as T;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return stored as T;
  }
}

function writeCookie<T>(name: string, next: T, options: DmsCookieOptions<T>) {
  const attributes = [
    `path=${options.path ?? "/"}`,
    options.maxAge === undefined ? "" : `max-age=${options.maxAge}`,
    options.sameSite ? `samesite=${options.sameSite}` : "",
    options.secure ? "secure" : "",
  ].filter(Boolean);
  // biome-ignore lint/suspicious/noDocumentCookie: reactive cookie refs require synchronous writes.
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(next ?? null))}; ${attributes.join("; ")}`;
}

function createCookieRef<T>(
  name: string,
  source: string | undefined,
  options: DmsCookieOptions<T>,
  isServer: boolean,
): Ref<T> {
  const value = ref(
    parseCookieValue(readCookie(source, name), options),
  ) as Ref<T>;
  return computed({
    get: () => value.value,
    set: (next) => {
      value.value = next;
      if (!isServer) writeCookie(name, next, options);
    },
  });
}

// The language a visitor picks, kept by the browser so that a reload renders
// in it. A signed-in user's own language still comes first.
const LOCALE_COOKIE = "dms_locale";
const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/**
 * The language this browser picked: read from `document.cookie`, or in a
 * server render from the request. Only one of `supportedLocales` counts.
 */
export function readDmsLocaleCookie(
  runtime: DmsFrontendRuntime,
  supportedLocales: string[],
): string | undefined {
  const source =
    typeof document === "undefined" ? runtime.requestCookies : document.cookie;
  try {
    const locale = parseCookieValue<unknown>(
      readCookie(source, LOCALE_COOKIE),
      {},
    );
    return typeof locale === "string" && supportedLocales.includes(locale)
      ? locale
      : undefined;
  } catch {
    // A value that is not URI-encoded: as if the browser had picked none.
    return undefined;
  }
}

/**
 * A cookie as a ref, shared by every caller of the same name — so a plugin and
 * a page reading one preference see each other's writes — and read on the
 * server from the request being rendered, so the server HTML matches the client.
 */
export function useDmsCookie<T = string | null>(
  name: string,
  options: DmsCookieOptions<T> = {},
): Ref<T> {
  if (typeof document !== "undefined") {
    if (!browserCookieRefs.has(name))
      browserCookieRefs.set(
        name,
        createCookieRef(name, document.cookie, options, false) as Ref<unknown>,
      );
    return browserCookieRefs.get(name) as Ref<T>;
  }
  const runtime = useDmsRuntime();
  const key = `${COOKIE_STATE_PREFIX}${name}`;
  if (!runtime.sharedState.has(key))
    runtime.sharedState.set(
      key,
      createCookieRef(
        name,
        runtime.requestCookies,
        options,
        true,
      ) as Ref<unknown>,
    );
  return runtime.sharedState.get(key) as Ref<T>;
}

export function createError(
  input: string | DmsErrorData,
): Error & DmsErrorData {
  const details = typeof input === "string" ? { message: input } : input;
  return Object.assign(
    new Error(details.message ?? details.statusMessage),
    details,
  );
}
export function showError(input: string | DmsErrorData): Error & DmsErrorData {
  const error = createError(input);
  useDmsRuntime().currentError.value = error;
  return error;
}
export function useError(): Ref<(Error & DmsErrorData) | null> {
  return useDmsRuntime().currentError as Ref<(Error & DmsErrorData) | null>;
}
export async function clearError(options?: {
  redirect?: string;
}): Promise<void> {
  useDmsRuntime().currentError.value = null;
  if (options?.redirect) await navigateDms(options.redirect);
}

function sessionIdentity(session: unknown): string {
  const { accountId, activeTenantId } = (session ?? {}) as Partial<DmsSession>;
  return `${accountId ?? ""}\n${activeTenantId ?? ""}`;
}

/**
 * Drops the pages Inertia prefetched (a hovered link) once the session is
 * another account's or workspace's, or none: each carries the user, the page
 * and the site layout of the session it was fetched with, and a visit would
 * show them as current.
 */
function forgetPrefetchedPages(): void {
  if (typeof window !== "undefined") inertiaRouter.flushAll();
}

/**
 * Warms what a prefetched page renders (its page, layout and block
 * components) once Inertia has its props, so following the link does not wait
 * for those chunks after the props.
 */
export function preloadPrefetchedDmsPages(): () => void {
  return inertiaRouter.on("prefetched", (event) => {
    const data = event.detail.response.data as unknown;
    let page: { props?: DmsPageProps } | undefined;
    try {
      page = (typeof data === "string" ? JSON.parse(data) : data) as
        | { props?: DmsPageProps }
        | undefined;
    } catch {
      return;
    }
    if (page?.props?.page) void preloadDmsPage(page.props).catch(() => {});
  });
}

export function useUserSession<
  TUser = DmsUser,
  TSession = DmsSession,
>(): DmsUserSession<TUser, TSession> {
  const user = useDmsState<TUser | null>("dms-user", () => null);
  const session = useDmsState<TSession | null>("dms-session", () => null);
  return {
    user,
    session,
    loggedIn: computed(() => user.value !== null),
    fetch: async () => {
      const before = sessionIdentity(session.value);
      const value = await ofetch<{
        user?: TUser;
        session?: TSession;
      }>("/api/_auth/session", { method: "POST" });
      user.value = value.user ?? null;
      session.value = value.session ?? null;
      if (sessionIdentity(session.value) !== before) forgetPrefetchedPages();
    },
    clear: async () => {
      await ofetch("/api/_auth/session", { method: "DELETE" });
      user.value = null;
      session.value = null;
      forgetPrefetchedPages();
    },
  };
}

/**
 * Whether the page loaded by the current navigation is still pending: its
 * chunk, or an async `setup` it awaits, has not resolved yet. A layout reads
 * it to show its own placeholder in place of the page. Always `false` on the
 * server and during hydration, which render the page resolved.
 */
export function useDmsPageLoading(): Readonly<Ref<boolean>> {
  return readonly(useDmsRuntime().pageLoading);
}

/**
 * The props of the `<Suspense>` around the page that keep `useDmsPageLoading`
 * in step with it. Cleared before the boundary unmounts, so a page left while
 * pending never leaves the state set.
 *
 * They also end the hydration: the page is on screen once its suspense
 * resolves, and the components after it once the tick is over, so the
 * browser has then hydrated what the server rendered. A hydrating suspense
 * never reports itself pending: the server rendered the page resolved.
 */
export function dmsPageSuspenseProps(): Record<string, () => void> {
  const runtime = useDmsRuntime();
  const loading = runtime.pageLoading;
  const settle = () => {
    loading.value = false;
  };
  return {
    onPending: () => {
      loading.value = true;
    },
    onResolve: () => {
      settle();
      if (runtime.hydrating) void nextTick(() => endHydration(runtime));
    },
    onVnodeBeforeUnmount: settle,
  };
}

/**
 * The key a component name is registered and resolved under: case, a leading
 * `lazy` and every non-alphanumeric character ignored, so PascalCase,
 * kebab-case and lowercase spellings match. Unlike `normalizeDmsName`, a
 * leading `Dms` is kept: it is the DMS module's prefix, and dropping it would
 * make `DmsBanner` and another module's `Banner` the same component.
 */
function normalizeDmsComponentName(name: string): string {
  return name
    .replace(/^lazy/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function moduleLabel(module: string | undefined): string {
  return module ? `module "${module}"` : "an unnamed module";
}

/**
 * A component registered under a name already taken is ignored: the first
 * registration, from the module of higher priority, keeps the name. That is
 * how a module replaces another's component, by registering its full name
 * without a prefix, and only a collision neither side asked for is reported.
 */
function registerDmsComponentEntry(
  entries: Map<string, DmsComponentRegistration>,
  registration: DmsComponentRegistration,
): void {
  const key = normalizeDmsComponentName(registration.name);
  const existing = entries.get(key);
  if (!existing) {
    entries.set(key, registration);
    return;
  }
  if (existing.unprefixed || registration.unprefixed) return;
  console.warn(
    `[dms] Component "${registration.name}" from ${moduleLabel(registration.module)} is ignored: ` +
      `${moduleLabel(existing.module)} already registers "${existing.name}". ` +
      "Give the modules different component prefixes.",
  );
}
/** Registers a component unless a higher-priority module already owns its name. */
export function registerDmsComponent(name: string, component: Component): void {
  registerDmsComponentEntry(registry.components, { name, component });
}
/**
 * Resolves a registered component by its full name, prefix included. Case,
 * a leading `lazy` and non-alphanumeric characters are ignored.
 */
export function resolveDmsComponent(name: string): Component | undefined {
  return registry.components.get(normalizeDmsComponentName(name))?.component;
}

/**
 * Records, by registered name, every registered async component a server
 * render reaches, so the client can resolve the same ones before hydrating.
 * Inertia re-renders the tree once on boot; an async component still loading
 * at that moment makes Vue drop its server-rendered markup ("Skipping lazy
 * hydration") and leave it empty until its chunk arrives.
 */
export function trackDmsAsyncComponents(app: App): Set<string> {
  const names = new Map<Component, string>();
  registry.components.forEach(({ component, name }) => {
    if ((component as DmsAsyncComponent).__asyncLoader)
      names.set(component, name);
  });
  const rendered = new Set<string>();
  app.mixin({
    beforeCreate(this: ComponentPublicInstance) {
      const name = names.get(this.$.type as Component);
      if (name) rendered.add(name);
    },
  });
  return rendered;
}

/**
 * Records the scope of every component a server render creates, and returns
 * the function that stops them once the render is over.
 *
 * A server app is never mounted, so it is never unmounted either: Vue leaves
 * the scope of each component it rendered running, and nothing handed to
 * `onScopeDispose` is ever released. Nuxt UI's `useRuntimeHook` registers in
 * a process-wide hook registry and only unregisters there, so every server
 * render of the dashboard sidebar stayed reachable, its whole component tree
 * and page props with it, until the server ran out of heap.
 *
 * The component's scope is read through `getCurrentScope`: Vue makes it the
 * active scope before it calls `beforeCreate`, and the instance's own `scope`
 * field is internal, absent from the typings a generated workspace checks.
 */
export function trackDmsServerScopes(app: App): () => void {
  const scopes: EffectScope[] = [];
  app.mixin({
    beforeCreate() {
      const scope = getCurrentScope();
      if (scope) scopes.push(scope);
    },
  });
  return () => {
    for (const scope of scopes.splice(0)) scope.stop();
  };
}

export async function resolveDmsAsyncComponents(
  names: readonly string[],
): Promise<void> {
  await Promise.all(
    names.map((name) =>
      (
        resolveDmsComponent(name) as DmsAsyncComponent | undefined
      )?.__asyncLoader?.(),
    ),
  );
}
export async function preloadComponents(names: string[]): Promise<void> {
  const registry = useDmsRuntime().appContext?.vueApp._context.components ?? {};
  await Promise.all(
    names.map((name) =>
      (registry[name] as DmsAsyncComponent | undefined)?.__asyncLoader?.(),
    ),
  );
}
export function normalizeDmsName(name: string): string {
  return name
    .replace(/^lazy/i, "")
    .replace(/^dms[-_]?/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function collectRenderedComponentNames(
  value: unknown,
  names: Set<string>,
): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      collectRenderedComponentNames(entry, names);
    });
    return;
  }
  const definition = value as Record<string, unknown>;
  for (const key of ["component", "componentName"]) {
    if (typeof definition[key] === "string") names.add(definition[key]);
  }
  // A child places a component definition: `{ id, component: { … } }`.
  if (typeof definition.component === "object")
    collectRenderedComponentNames(definition.component, names);
  collectRenderedComponentNames(definition.children, names);
}

async function preloadDmsLayoutComponents(
  layout: DmsPageLayout | undefined,
): Promise<void> {
  const names = new Set<string>();
  collectRenderedComponentNames(layout?.layout, names);
  Object.values(layout?.components ?? {}).forEach((component) => {
    collectRenderedComponentNames(component, names);
  });
  await Promise.all(
    [...names].map((name) => {
      const component = resolveDmsComponent(name) as
        | DmsAsyncComponent
        | undefined;
      return component?.__asyncLoader?.();
    }),
  );
}

export function normalizeDmsPageKey(name: string): string {
  return name.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
}
const CATCH_ALL_PAGE_KEY = "[...slug]";

function findDmsPageEntry(props: DmsPageProps): DmsFrontendEntry | undefined {
  const name = [
    props.page.componentName,
    props.page.route?.fullSlug,
    props.path,
  ].find(
    (candidate) =>
      candidate && registry.pages.has(normalizeDmsPageKey(candidate)),
  );
  return name
    ? registry.pages.get(normalizeDmsPageKey(name))
    : registry.dynamicPages.get(CATCH_ALL_PAGE_KEY);
}

/** The path a frontend module registered for a typed backend refusal. */
export function resolveDmsAccessRedirect(code: string): string | undefined {
  return registry.accessRedirects.get(code);
}
export function hasDmsPage(name: string): boolean {
  return registry.pages.has(normalizeDmsPageKey(name));
}
export function getDmsPage(props: DmsPageProps): Component | undefined {
  if (props.error) return registry.errorPage?.component;
  return findDmsPageEntry(props)?.component;
}
export function getDmsDynamicPage(name = "default"): Component | undefined {
  return registry.dynamicPages.get(name)?.component;
}
export function getDmsLayout(props: DmsPageProps): Component | undefined {
  const layout = props.page.layout;
  const name = layout?.layout?.componentName ?? layout?.componentName;
  return name
    ? registry.layouts.get(normalizeDmsName(name))?.component
    : undefined;
}
export function getDmsLayoutProps(
  props: DmsPageProps,
): Record<string, unknown> {
  const definition = props.page.layout?.layout;
  return {
    ...(definition?.options ?? {}),
    icon: props.page.route?.icon,
    title: props.page.route?.displayName,
    description: props.page.route?.description,
  };
}

/**
 * Whether a page carries an older session of the same account than the one
 * the app holds: Inertia restores a page from history, or serves it from the
 * prefetch cache, with the props it was fetched with, and those must not undo
 * a later `useUserSession().fetch()`.
 */
function isStaleSession(
  incoming: DmsSession | undefined,
  current: DmsSession | null,
): boolean {
  return (
    !!incoming &&
    !!current &&
    incoming.accountId === current.accountId &&
    (incoming.updatedAt ?? 0) < (current.updatedAt ?? 0)
  );
}

/**
 * Copies the site layout of the page props into the state. A visit carries
 * the layout it was sent over from page to page (a once prop): the same copy
 * is applied once, so the state keeps what a later refresh wrote into it, and
 * `dms-lastRefreshTime` tells when the layout was last received.
 */
export function hydrateDmsSharedProps(
  shared: DmsSharedPagePayload | undefined,
): void {
  const runtime = useDmsRuntime();
  if (!shared || shared === runtime.appliedShared) return;
  // A page from the history carries the layout it was shown with, which the
  // state has replaced since: see `keepSharedOverHistory`.
  if (runtime.restoringHistory) return;
  runtime.appliedShared = shared;
  useDmsState<unknown>("dms-siteLayout", () => undefined).value =
    shared.siteLayout;
  useDmsState<unknown>("dms-pageTree", () => undefined).value =
    shared.siteLayoutTree;
  useDmsState<unknown>("dms-quickActions", () => undefined).value =
    shared.quickActions;
  useDmsState<unknown>("dms-modules", () => undefined).value = shared.modules;
  useDmsState("dms-isOwner", () => false).value = shared.isOwner ?? false;
  useDmsState("dms-lastRefreshTime", () => 0).value = Date.now();
}

/**
 * Keeps the newest site layout when Back or Forward puts a page back. The
 * page carries the layout it was shown with, which a later reload replaced
 * (a menu change the backend announced); it is not copied into the state, and
 * the page is given the current one, so the next visit carries that over
 * rather than the older one.
 */
export function keepSharedOverHistory(): () => void {
  const runtime = useDmsRuntime();
  const onPopstate = (event: PopStateEvent) => {
    // Inertia restores only the entries it wrote, which hold a page.
    if ((event.state as { page?: unknown } | null)?.page)
      runtime.restoringHistory = true;
  };
  window.addEventListener("popstate", onPopstate);
  const stopListening = inertiaRouter.on("navigate", (event) => {
    if (!runtime.restoringHistory) return;
    runtime.restoringHistory = false;
    const current = runtime.appliedShared;
    const restored = (event.detail.page.props as Partial<DmsPageProps>).shared;
    if (current && restored !== current)
      inertiaRouter.replaceProp("shared", current);
  });
  return () => {
    window.removeEventListener("popstate", onPopstate);
    stopListening();
  };
}

export function hydrateDmsPageProps(props: DmsPageProps, url?: string): void {
  const runtime = useDmsRuntime();
  if (url) updateRoute(runtime, url);
  // Pages are keyed by path: another path mounts another page, which declares
  // its own meta, and so does an error page shown in place of the page. A
  // visit that only changes the query keeps the page, and so its meta.
  const pageKey = props.error ? `error:${props.path}` : props.path;
  if (pageKey !== runtime.pageKey) {
    runtime.pageKey = pageKey;
    runtime.route.meta = {};
  }
  dropUnusedAsyncData(runtime);
  runtime.currentError.value = null;
  const session = useDmsState<DmsSession | null>("dms-session", () => null);
  if (!isStaleSession(props.session, session.value)) {
    useDmsState<DmsUser | null>("dms-user", () => null).value =
      props.user ?? null;
    session.value = props.session ?? null;
  }
  hydrateDmsSharedProps(props.shared);
  const layoutUrl = props.page.route?.layoutUrl ?? props.page.layoutUrl;
  const pageLayouts = useDmsState<Record<string, DmsPageLayout>>(
    "dms-pageLayouts",
    () => ({}),
  );
  // Each navigation is a new authorization snapshot. Never retain layouts
  // from an earlier account, tenant, or permission context.
  pageLayouts.value =
    layoutUrl && props.page.layout ? { [layoutUrl]: props.page.layout } : {};
}
/**
 * Ends the hydration of the page the server rendered. The server's data no
 * component took over is dropped: a later page must not show it as current.
 */
function endHydration(runtime: DmsFrontendRuntime): void {
  runtime.hydrating = false;
  runtime.hydratedAsyncData.clear();
  runtime.hydratedAsyncErrors.clear();
}

export function getDmsErrorPage(): Component | undefined {
  return registry.errorPage?.component;
}

export async function preloadDmsPage(props: DmsPageProps): Promise<void> {
  const layoutName =
    props.page.layout?.layout?.componentName ??
    props.page.layout?.componentName;
  const page = findDmsPageEntry(props) ?? registry.dynamicPages.get("default");
  const layout = layoutName
    ? registry.layouts.get(normalizeDmsName(layoutName))
    : undefined;
  const entries = props.error ? [registry.errorPage] : [page, layout];
  // `preload` only warms the module; the async wrapper stays unresolved until
  // its own loader runs. Hydrating an unresolved wrapper defers it, and the
  // first parent render (Inertia's initial swap) then makes Vue drop the
  // server-rendered markup and render the subtree from scratch.
  await Promise.all(
    entries.flatMap((entry) => [
      entry?.preload?.(),
      (entry?.component as DmsAsyncComponent | undefined)?.__asyncLoader?.(),
    ]),
  );
  if (!props.error) await preloadDmsLayoutComponents(props.page.layout);
}

export function useDmsInjection<T>(
  key: string | InjectionKey<T>,
): T | undefined {
  return inject(key as InjectionKey<T>, undefined);
}

function registerDmsFrontendEntry(
  entries: Map<string, DmsFrontendEntry>,
  name: string,
  component: Component,
  preload?: DmsComponentPreloader,
): void {
  if (!entries.has(name)) entries.set(name, { component, preload });
}

/** `name` behind `prefix`, as a PascalCase component name. */
function prefixedComponentName(prefix: string, name: string): string {
  return prefix ? `${prefix}${capitalize(camelize(name))}` : name;
}

function createSdk(
  target: DmsFrontendRegistry,
  {
    name: module,
    module: { componentPrefix = "" },
    options,
  }: DmsFrontendModuleRegistration,
): DmsFrontendSdk {
  return {
    options,
    registerComponent: (name, component, { prefix = true } = {}) =>
      registerDmsComponentEntry(target.components, {
        name: prefix ? prefixedComponentName(componentPrefix, name) : name,
        component,
        module,
        unprefixed: !prefix,
      }),
    registerPage: (name, component, preload) => {
      const key = normalizeDmsPageKey(name);
      registerDmsFrontendEntry(target.pages, key, component, preload);
    },
    registerDynamicPage: (name, component, preload) =>
      registerDmsFrontendEntry(target.dynamicPages, name, component, preload),
    registerLayout: (name, component, preload) => {
      const key = normalizeDmsName(name);
      registerDmsFrontendEntry(target.layouts, key, component, preload);
    },
    registerErrorPage: (component, preload) => {
      target.errorPage ??= { component, preload };
    },
    registerPlugin: (setup, options = {}) =>
      target.pluginSetups.push({
        setup,
        clientOnly: options.clientOnly ?? false,
      }),
    registerMiddleware: (name, handler, options = {}) => {
      if (!target.namedMiddleware.has(name))
        target.namedMiddleware.set(name, handler);
      if (options.global) target.middleware.push(handler);
      if (options.parallel) target.parallelMiddleware.add(handler);
    },
    registerAccessRedirect: (code, path) => {
      if (!target.accessRedirects.has(code))
        target.accessRedirects.set(code, path);
    },
    provide: (key, value) => {
      if (!target.injections.has(key)) target.injections.set(key, value);
    },
    use: (plugin) => target.plugins.push(plugin),
  };
}

/**
 * Sets the frontend modules up in their generated priority order, into a
 * registry of their own that replaces the previous one once complete.
 *
 * The browser and a production server set the modules up once. A development
 * server sets them up again each time Vite evaluates the server renderer anew
 * after a layer changes, but keeps this module and its state: registering into
 * the previous registry, the new components lost their names to the ones they
 * replace, so the server kept rendering the old ones, and every list gained the
 * same entries once more. A render still in progress keeps reading a complete
 * registry: the new one is only published once every module is set up.
 *
 * `useDmsAppConfig()` holds the layers' app configs merged, highest precedence
 * first, before the first module is set up: a project's layer overrides the
 * DMS's, which fills in the rest. A setup may still read and extend it.
 */
export async function setupFrontendModules(
  registrations: DmsFrontendModuleRegistration[],
  layerAppConfigs: DmsLayerAppConfig[] = [],
): Promise<void> {
  const next = createDmsFrontendRegistry();
  const configs = layerAppConfigs.map(({ config }) => config);
  // Modules read and extend these two while they are set up, so they restart
  // here rather than being published with the registry: the public options
  // empty, the app config from the layers alone.
  runtimeConfig.value.public = {} as PublicRuntimeConfig;
  appConfig.value = mergeLayerAppConfigs(configs);
  for (const registration of registrations) {
    runtimeConfig.value.public = defu(
      runtimeConfig.value.public,
      registration.options.public,
    );
    await registration.module.setup(createSdk(next, registration));
  }
  appConfigSetupChanges = appConfigChanges(
    mergeLayerAppConfigs(configs),
    appConfig.value,
  );
  registry = next;
}

/**
 * Development only: applies the layers' app configs, edited while the page
 * is open, to `useDmsAppConfig()`, with what the setup of the modules changed
 * in the previous ones still on top. The object is updated in place, records
 * included, since components hold it: the modules are not set up again.
 */
export function updateDmsAppConfig(layerAppConfigs: DmsLayerAppConfig[]): void {
  const layered = mergeLayerAppConfigs(
    layerAppConfigs.map(({ config }) => config),
  );
  assignInPlace(
    appConfig.value,
    withAppConfigChanges(layered, appConfigSetupChanges),
  );
}

export async function installDmsPlugins(
  app: App,
  i18n: Composer,
  runtime: DmsFrontendRuntime,
  loadLocaleMessages: DmsLocaleLoader,
  supportedLocales: string[],
): Promise<() => Promise<void>> {
  const dmsI18n = i18n as DmsI18n;
  const hooks = new Map<string, Array<() => void | Promise<void>>>();
  const appContext: DmsAppContext = {
    vueApp: app,
    $i18n: dmsI18n,
    provide: (key, value) => {
      app.provide(key, value);
      app.config.globalProperties[`$${key}`] = value;
    },
    runWithContext: (callback) => app.runWithContext(callback),
    hook: (name, callback) =>
      hooks.set(name, [...(hooks.get(name) ?? []), callback]),
  };
  runtime.appContext = appContext;
  if (typeof window !== "undefined" && !runtime.hasNavigationListener) {
    runtime.hasNavigationListener = true;
    const stopNavigationListener = inertiaRouter.on("before", () => {
      runtime.currentError.value = null;
    });
    app.onUnmount(() => {
      stopNavigationListener();
      runtime.hasNavigationListener = false;
      if (browserRuntime === runtime) browserRuntime = undefined;
    });
  }
  app.config.errorHandler = (reason) => failPage(runtime, reason);
  app.config.globalProperties.$dms = appContext;
  Reflect.set(app, "$dms", appContext);
  Reflect.set(app, "$i18n", i18n);
  Reflect.set(appContext.vueApp, "$dms", appContext);
  Reflect.set(app.config.globalProperties, "$i18n", i18n);
  dmsI18n.setLocale = async (locale: string) => {
    const messages = await loadLocaleMessages(locale);
    i18n.setLocaleMessage(locale, messages);
    i18n.locale.value = locale;
    if (typeof document !== "undefined" && supportedLocales.includes(locale))
      writeCookie(LOCALE_COOKIE, locale, {
        maxAge: LOCALE_COOKIE_MAX_AGE,
        sameSite: "lax",
        secure: globalThis.location?.protocol === "https:",
      });
  };
  dmsI18n.locales = computed(() =>
    supportedLocales.map((code) => ({
      code,
      name: new Intl.DisplayNames([code], { type: "language" }).of(code),
    })),
  );
  app.component("DmsLink", DmsLink);
  app.component("DmsClientOnly", DmsClientOnly);
  registry.components.forEach(({ component, name }) => {
    app.component(name, component);
  });
  registry.injections.forEach((value, key) => {
    app.provide(key, value);
  });
  registry.plugins.forEach((plugin) => {
    app.use(plugin);
  });
  for (const registration of registry.pluginSetups) {
    if (registration.clientOnly && typeof window === "undefined") continue;
    await runtime.scope.run(() =>
      app.runWithContext(() => registration.setup(appContext)),
    );
  }
  // What plugins start without awaiting it is still part of the page a
  // server renders: its HTML shows it, so the render waits for it.
  if (runtime.isServer) await Promise.all(runtime.serverPrefetches);
  return async () => {
    for (const callback of hooks.get("app:mounted") ?? []) await callback();
  };
}
