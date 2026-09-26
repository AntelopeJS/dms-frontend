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
  computed,
  defineComponent,
  getCurrentInstance,
  getCurrentScope,
  h,
  hasInjectionContext,
  type InjectionKey,
  inject,
  onMounted,
  onScopeDispose,
  type Plugin,
  type PropType,
  type Ref,
  reactive,
  ref,
  watch,
} from "vue";
import type { Composer } from "vue-i18n";
import { useI18n as useVueI18n } from "vue-i18n";

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
  shared?: DmsSharedPagePayload;
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
export interface DmsAsyncData<T> {
  data: Ref<T | null>;
  error: Ref<unknown>;
  pending: Ref<boolean>;
  status: Ref<"idle" | "pending" | "success" | "error">;
  execute(): Promise<void>;
  refresh(): Promise<void>;
}
export interface UseFetchOptions<T> extends FetchOptions {
  immediate?: boolean;
  watch?: false | unknown[];
  default?: () => T;
  transform?: (value: unknown) => T | Promise<T>;
  pick?: string[];
  $fetch?: typeof ofetch;
}
export interface UseAsyncDataOptions<T> {
  default?: () => T;
  immediate?: boolean;
  lazy?: boolean;
  server?: boolean;
  watch?: false | unknown[];
  transform?: (value: unknown) => T | Promise<T>;
  pick?: string[];
}
export interface DmsErrorData {
  statusCode?: number;
  statusMessage?: string;
  message?: string;
  data?: unknown;
  fatal?: boolean;
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
export type DmsColorModePreference = "system" | "light" | "dark";
type DmsLinkPrefetchMode = "mount" | "hover" | "click";
type DmsLinkPrefetch = boolean | DmsLinkPrefetchMode | DmsLinkPrefetchMode[];
export interface DmsColorMode {
  preference: DmsColorModePreference;
  value: "light" | "dark";
  unknown: boolean;
  forced: boolean;
}
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
}
export interface DmsPluginRegistrationOptions {
  clientOnly?: boolean;
}
export type DmsComponentPreloader = () => Promise<unknown>;
export interface DmsFrontendSdk {
  options: DmsModuleOptions;
  registerComponent(name: string, component: Component): void;
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
  setup(sdk: DmsFrontendSdk): void | Promise<void>;
}
export interface DmsFrontendModuleRegistration {
  module: DmsFrontendModule;
  options: DmsModuleOptions;
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

export interface DmsFrontendRuntime {
  sharedState: Map<string, Ref<unknown>>;
  asyncData: Map<string, DmsAsyncData<unknown>>;
  asyncDataPromises: Map<string, Promise<void>>;
  hydratedAsyncData: Map<string, unknown>;
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
  pageVersion: number;
  /** The `Cookie` header of the request a server runtime renders. */
  requestCookies?: string;
}

const components = new Map<string, DmsComponentRegistration>();
const pages = new Map<string, DmsFrontendEntry>();
const dynamicPages = new Map<string, DmsFrontendEntry>();
const layouts = new Map<string, DmsFrontendEntry>();
let errorPage: DmsFrontendEntry | undefined;
const plugins: Plugin[] = [];
const pluginSetups: DmsPluginRegistration[] = [];
const middleware: DmsMiddleware[] = [];
const namedMiddleware = new Map<string, DmsMiddleware>();
const accessRedirects = new Map<string, string>();
const injections = new Map<string | symbol, unknown>();
const runtimeConfig = ref<DmsRuntimeConfig>({
  public: {},
} as DmsRuntimeConfig);
const appConfig = ref<Record<string, unknown>>({});
const COLOR_MODE_STORAGE_KEY = "dms-color-mode";
const COLOR_MODE_CLASSES = ["light", "dark"];
const colorMode = reactive<DmsColorMode>({
  preference: "system",
  value: "light",
  unknown: false,
  forced: false,
});
let isColorModeInitialized = false;
const DMS_RUNTIME_KEY: InjectionKey<DmsFrontendRuntime> = Symbol("dms-runtime");
type DmsRuntimeContext = DmsAppContext["runWithContext"];
const runtimeContexts = new WeakMap<DmsFrontendRuntime, DmsRuntimeContext>();
let serverRuntimeResolver: (() => DmsFrontendRuntime | undefined) | undefined;
let browserRuntime: DmsFrontendRuntime | undefined;

/** Creates mutable runtime state owned by one Vue application. */
export function createDmsFrontendRuntime(
  serverFetch?: typeof ofetch,
  hydratedAsyncData: Record<string, unknown> = {},
  isServer = false,
  requestCookies?: string,
): DmsFrontendRuntime {
  return {
    requestCookies,
    sharedState: new Map(),
    asyncData: new Map(),
    asyncDataPromises: new Map(),
    hydratedAsyncData: new Map(Object.entries(hydratedAsyncData)),
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
    pageVersion: 0,
  };
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

function updateRoute(runtime: DmsFrontendRuntime, url: string): void {
  Object.assign(runtime.route, parseRoute(runtime, url));
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
    .map((name) => namedMiddleware.get(String(name)))
    .filter((handler): handler is DmsMiddleware => !!handler);
  for (const handler of [...middleware, ...declaredHandlers]) {
    const runWithContext = runtimeContexts.get(runtime);
    const result = await (runWithContext
      ? runWithContext(() => handler(to, runtime.route))
      : handler(to, runtime.route));
    if (result !== undefined) return result;
  }
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
  const page = usePage();
  updateRoute(runtime, page.url);
  watch(
    () => page.url,
    (url) => updateRoute(runtime, url),
  );
  return runtime.route;
}

export function useDmsRouter(): DmsRouter {
  const runtime = useDmsRuntime();
  const navigate = (to: RouteLocationRaw, options?: DmsNavigationOptions) =>
    locationToUrl(runtime, to) === runtime.route.fullPath
      ? Promise.resolve()
      : visit(runtime, to, options);
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

function createDmsFetch(defaults: FetchOptions = {}): typeof ofetch {
  const execute = (request: string, options?: FetchOptions) => {
    const runtime = useDmsRuntime();
    return (runtime.serverFetch ?? ofetch)(request, {
      ...defaults,
      ...options,
    });
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

function fetchOptions<T>(options: UseFetchOptions<T>): FetchOptions {
  const {
    immediate: _immediate,
    watch: _watch,
    default: _default,
    transform: _transform,
    pick: _pick,
    $fetch: _fetch,
    ...requestOptions
  } = options;
  return requestOptions;
}

export function useDmsFetch<T>(
  request: string | (() => string),
  options: UseFetchOptions<T> = {},
): DmsAsyncData<T> {
  const runtime = useDmsRuntime();
  const data = ref<T | null>(options.default?.() ?? null) as Ref<T | null>;
  const error = ref<unknown>(null);
  const pending = ref(false);
  const status = ref<"idle" | "pending" | "success" | "error">("idle");
  const refresh = async (): Promise<void> => {
    pending.value = true;
    status.value = "pending";
    error.value = null;
    try {
      const value = await (options.$fetch ?? runtime.serverFetch ?? ofetch)(
        typeof request === "function" ? request() : request,
        fetchOptions(options),
      );
      const transformed = options.transform
        ? await options.transform(value)
        : value;
      data.value = pickValue<T>(transformed, options.pick);
      status.value = "success";
    } catch (reason) {
      error.value = reason;
      status.value = "error";
    } finally {
      pending.value = false;
    }
  };
  if (options.watch !== false) {
    const sources = [
      ...(typeof request === "function" ? [request] : []),
      ...(options.watch ?? []),
    ] as never[];
    if (sources.length) watch(sources, refresh);
  }
  if (options.immediate !== false) void refresh();
  return { data, error, pending, status, execute: refresh, refresh };
}

interface AsyncDataBinding<T> {
  execute: () => Promise<T>;
  options: UseAsyncDataOptions<T>;
  active: boolean;
  pageVersion: number;
}

interface BoundAsyncData<T> extends DmsAsyncData<T> {
  bind(binding: AsyncDataBinding<T>): boolean;
}

interface AsyncDataRegistration<T> {
  entry: BoundAsyncData<T>;
  shouldRefresh: boolean;
}

function createBoundAsyncData<T>(
  initial: T | null,
  hydrated: boolean,
): BoundAsyncData<T> {
  const data = ref(initial) as Ref<T | null>;
  const error = ref<unknown>(null);
  const pending = ref(false);
  const status = ref<DmsAsyncData<T>["status"]["value"]>(
    hydrated ? "success" : "idle",
  );
  const bindings: AsyncDataBinding<T>[] = [];
  let generation = 0;
  let lastBindingPageVersion: number | undefined;
  let pendingBinding: AsyncDataBinding<T> | undefined;
  const refresh = async () => {
    const binding = bindings.at(-1);
    if (!binding) return;
    const request = ++generation;
    pendingBinding = binding;
    pending.value = true;
    status.value = "pending";
    error.value = null;
    const current = () => binding.active && request === generation;
    try {
      const value = await binding.execute();
      const transformed = binding.options.transform
        ? await binding.options.transform(value)
        : value;
      if (!current()) return;
      data.value = pickValue<T>(transformed, binding.options.pick);
      status.value = "success";
    } catch (reason) {
      if (!current()) return;
      error.value = reason;
      status.value = "error";
    } finally {
      if (current()) pending.value = false;
    }
  };
  return {
    data,
    error,
    pending,
    status,
    execute: refresh,
    refresh,
    bind(binding) {
      const shouldRefresh =
        bindings.length === 0 &&
        lastBindingPageVersion !== undefined &&
        lastBindingPageVersion !== binding.pageVersion;
      lastBindingPageVersion = binding.pageVersion;
      bindings.push(binding);
      if (binding.options.watch && binding.options.watch.length)
        watch(binding.options.watch as never[], refresh);
      if (getCurrentScope())
        onScopeDispose(() => {
          binding.active = false;
          bindings.splice(bindings.indexOf(binding), 1);
          if (pendingBinding === binding && pending.value) {
            generation++;
            pending.value = false;
            status.value = data.value === null ? "idle" : "success";
          }
        });
      return shouldRefresh;
    },
  };
}

function createAsyncData<T>(
  runtime: DmsFrontendRuntime,
  keyOrHandler: string | (() => Promise<T>),
  handler?: () => Promise<T>,
  options: UseAsyncDataOptions<T> = {},
): AsyncDataRegistration<T> {
  const execute =
    handler ?? (typeof keyOrHandler === "function" ? keyOrHandler : undefined);
  if (!execute) throw new Error("useDmsAsyncData requires a handler");
  const key = typeof keyOrHandler === "string" ? keyOrHandler : undefined;
  const hasHydratedData = key ? runtime.hydratedAsyncData.has(key) : false;
  const hydratedData = key ? runtime.hydratedAsyncData.get(key) : undefined;
  const cached = key
    ? (runtime.asyncData.get(key) as BoundAsyncData<T> | undefined)
    : undefined;
  const entry =
    cached ??
    createBoundAsyncData<T>(
      hasHydratedData ? (hydratedData as T) : (options.default?.() ?? null),
      hasHydratedData,
    );
  const shouldRefresh = entry.bind({
    execute,
    options,
    active: true,
    pageVersion: runtime.pageVersion,
  });
  if (key) runtime.asyncData.set(key, entry as DmsAsyncData<unknown>);
  return { entry, shouldRefresh };
}

export async function useDmsAsyncData<T>(
  keyOrHandler: string | (() => Promise<T>),
  handler?: () => Promise<T>,
  options: UseAsyncDataOptions<T> = {},
): Promise<DmsAsyncData<T>> {
  const runtime = useDmsRuntime();
  const key = typeof keyOrHandler === "string" ? keyOrHandler : undefined;
  const cached = key ? runtime.asyncData.get(key) : undefined;
  const isHydrated = key ? runtime.hydratedAsyncData.has(key) : false;
  const { entry, shouldRefresh } = createAsyncData(
    runtime,
    keyOrHandler,
    handler,
    options,
  );
  if (key) runtime.hydratedAsyncData.delete(key);
  const pending =
    key && entry.pending.value ? runtime.asyncDataPromises.get(key) : undefined;
  if (pending) await pending;
  if (
    (!cached || entry.status.value === "idle" || shouldRefresh) &&
    !isHydrated &&
    !pending &&
    options.immediate !== false
  ) {
    const execution = entry.execute();
    if (key) runtime.asyncDataPromises.set(key, execution);
    await execution;
    if (key && runtime.asyncDataPromises.get(key) === execution)
      runtime.asyncDataPromises.delete(key);
  }
  return entry;
}

export function useDmsLazyAsyncData<T>(
  keyOrHandler: string | (() => Promise<T>),
  handler?: () => Promise<T>,
  options: UseAsyncDataOptions<T> = {},
): DmsAsyncData<T> {
  const runtime = useDmsRuntime();
  const key = typeof keyOrHandler === "string" ? keyOrHandler : undefined;
  const { entry, shouldRefresh } = createAsyncData(
    runtime,
    keyOrHandler,
    handler,
    options,
  );
  if (key) runtime.hydratedAsyncData.delete(key);
  if (
    options.immediate !== false &&
    (entry.status.value === "idle" || shouldRefresh)
  )
    queueMicrotask(() => {
      if (
        entry.status.value === "idle" ||
        (shouldRefresh && !entry.pending.value)
      )
        void entry.execute();
    });
  return entry;
}

export async function refreshDmsData(keys?: string | string[]): Promise<void> {
  const runtime = useDmsRuntime();
  const selected = keys
    ? Array.isArray(keys)
      ? keys
      : [keys]
    : [...runtime.asyncData.keys()];
  await Promise.all(
    selected.map((key) => runtime.asyncData.get(key)?.refresh()),
  );
}

export function serializeDmsAsyncData(
  runtime: DmsFrontendRuntime,
): Record<string, unknown> {
  return Object.fromEntries(
    [...runtime.asyncData.entries()]
      .filter(([, entry]) => entry.status.value === "success")
      .map(([key, entry]) => [key, entry.data.value]),
  );
}

export function useDmsState<T>(key: string, init?: () => T): Ref<T> {
  const runtime = useDmsRuntime();
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
export function configureDmsRuntime(config: DmsRuntimeConfig): void {
  runtimeConfig.value = config;
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
  const navigation = runMiddleware(runtime, runtime.route).then(
    async (result) => {
      if (result !== undefined && result !== false)
        await visit(runtime, result);
    },
  );
  runtime.pendingNavigation = runtime.pendingNavigation
    ? Promise.all([runtime.pendingNavigation, navigation]).then(() => undefined)
    : navigation;
  void runtime.pendingNavigation;
}
export function abortNavigation(): false {
  return false;
}
export function addDmsMiddleware(
  handler: DmsMiddleware,
  name?: string,
  isGlobal = false,
): void {
  if (isGlobal) middleware.push(handler);
  else if (name) namedMiddleware.set(name, handler);
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

function preferredColorMode(): "light" | "dark" {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function applyColorMode(preference: DmsColorModePreference): void {
  colorMode.value = preference === "system" ? preferredColorMode() : preference;
  document.documentElement.classList.remove(...COLOR_MODE_CLASSES);
  document.documentElement.classList.add(colorMode.value);
}

function initializeColorMode(): void {
  if (isColorModeInitialized) return;
  isColorModeInitialized = true;
  if (typeof window === "undefined") return;
  const stored = window.localStorage.getItem(COLOR_MODE_STORAGE_KEY);
  if (COLOR_MODE_CLASSES.includes(stored ?? "") || stored === "system") {
    colorMode.preference = stored as DmsColorModePreference;
  }
  watch(
    () => colorMode.preference,
    (preference) => {
      applyColorMode(preference);
      window.localStorage.setItem(COLOR_MODE_STORAGE_KEY, preference);
    },
    { immediate: true },
  );
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (colorMode.preference === "system") applyColorMode("system");
    });
}

export function useColorMode(): DmsColorMode {
  initializeColorMode();
  return colorMode;
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
      const value = await ofetch<{
        user?: TUser;
        session?: TSession;
      }>("/api/_auth/session", { method: "POST" });
      user.value = value.user ?? null;
      session.value = value.session ?? null;
    },
    clear: async () => {
      await ofetch("/api/_auth/session", { method: "DELETE" });
      user.value = null;
      session.value = null;
    },
  };
}

/** Registers a component unless a higher-priority module already owns its name. */
export function registerDmsComponent(name: string, component: Component): void {
  const key = normalizeDmsName(name);
  if (!components.has(key)) components.set(key, { name, component });
}
export function resolveDmsComponent(name: string): Component | undefined {
  return components.get(normalizeDmsName(name))?.component;
}
export const getDmsComponent = resolveDmsComponent;

/**
 * Records, by registered name, every registered async component a server
 * render reaches, so the client can resolve the same ones before hydrating.
 * Inertia re-renders the tree once on boot; an async component still loading
 * at that moment makes Vue drop its server-rendered markup ("Skipping lazy
 * hydration") and leave it empty until its chunk arrives.
 */
export function trackDmsAsyncComponents(app: App): Set<string> {
  const names = new Map<Component, string>();
  components.forEach(({ component, name }) => {
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
export const prefetchComponents = preloadComponents;
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
  ].find((candidate) => candidate && pages.has(normalizeDmsPageKey(candidate)));
  return name
    ? pages.get(normalizeDmsPageKey(name))
    : dynamicPages.get(CATCH_ALL_PAGE_KEY);
}

/** The path a frontend module registered for a typed backend refusal. */
export function resolveDmsAccessRedirect(code: string): string | undefined {
  return accessRedirects.get(code);
}
export function hasDmsPage(name: string): boolean {
  return pages.has(normalizeDmsPageKey(name));
}
export function getDmsPage(props: DmsPageProps): Component | undefined {
  if (props.error) return errorPage?.component;
  return findDmsPageEntry(props)?.component;
}
export function getDmsDynamicPage(name = "default"): Component | undefined {
  return dynamicPages.get(name)?.component;
}
export function getDmsLayout(props: DmsPageProps): Component | undefined {
  const layout = props.page.layout;
  const name = layout?.layout?.componentName ?? layout?.componentName;
  return name ? layouts.get(normalizeDmsName(name))?.component : undefined;
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

export function hydrateDmsPageProps(props: DmsPageProps, url?: string): void {
  const runtime = useDmsRuntime();
  if (url) updateRoute(runtime, url);
  runtime.pageVersion++;
  runtime.currentError.value = null;
  useDmsState<DmsUser | null>("dms-user", () => null).value =
    props.user ?? null;
  useDmsState<DmsSession | null>("dms-session", () => null).value =
    props.session ?? null;
  const shared = props.page.shared;
  if (shared) {
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
export function getDmsErrorPage(): Component | undefined {
  return errorPage?.component;
}

export async function preloadDmsPage(props: DmsPageProps): Promise<void> {
  const layoutName =
    props.page.layout?.layout?.componentName ??
    props.page.layout?.componentName;
  const page = findDmsPageEntry(props) ?? dynamicPages.get("default");
  const layout = layoutName
    ? layouts.get(normalizeDmsName(layoutName))
    : undefined;
  const entries = props.error ? [errorPage] : [page, layout];
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
  registry: Map<string, DmsFrontendEntry>,
  name: string,
  component: Component,
  preload?: DmsComponentPreloader,
): void {
  if (!registry.has(name)) registry.set(name, { component, preload });
}

function createSdk(options: DmsModuleOptions): DmsFrontendSdk {
  return {
    options,
    registerComponent: registerDmsComponent,
    registerPage: (name, component, preload) => {
      const key = normalizeDmsPageKey(name);
      registerDmsFrontendEntry(pages, key, component, preload);
    },
    registerDynamicPage: (name, component, preload) =>
      registerDmsFrontendEntry(dynamicPages, name, component, preload),
    registerLayout: (name, component, preload) => {
      const key = normalizeDmsName(name);
      registerDmsFrontendEntry(layouts, key, component, preload);
    },
    registerErrorPage: (component, preload) => {
      errorPage ??= { component, preload };
    },
    registerPlugin: (setup, options = {}) =>
      pluginSetups.push({ setup, clientOnly: options.clientOnly ?? false }),
    registerMiddleware: (name, handler, options = {}) => {
      if (!namedMiddleware.has(name)) namedMiddleware.set(name, handler);
      if (options.global) middleware.push(handler);
    },
    registerAccessRedirect: (code, path) => {
      if (!accessRedirects.has(code)) accessRedirects.set(code, path);
    },
    provide: (key, value) => {
      if (!injections.has(key)) injections.set(key, value);
    },
    use: (plugin) => plugins.push(plugin),
  };
}

/** Initializes frontend adapters in their generated priority order. */
export async function setupFrontendModules(
  registrations: DmsFrontendModuleRegistration[],
): Promise<void> {
  for (const registration of registrations) {
    runtimeConfig.value.public = defu(
      runtimeConfig.value.public,
      registration.options.public,
    );
    await registration.module.setup(createSdk(registration.options));
  }
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
  app.config.errorHandler = (reason) => {
    runtime.currentError.value ??=
      reason instanceof Error ? reason : new Error(String(reason));
  };
  app.config.globalProperties.$dms = appContext;
  Reflect.set(app, "$dms", appContext);
  Reflect.set(app, "$i18n", i18n);
  Reflect.set(appContext.vueApp, "$dms", appContext);
  Reflect.set(app.config.globalProperties, "$i18n", i18n);
  dmsI18n.setLocale = async (locale: string) => {
    const messages = await loadLocaleMessages(locale);
    i18n.setLocaleMessage(locale, messages);
    i18n.locale.value = locale;
  };
  dmsI18n.locales = computed(() =>
    supportedLocales.map((code) => ({
      code,
      name: new Intl.DisplayNames([code], { type: "language" }).of(code),
    })),
  );
  app.component("DmsLink", DmsLink);
  app.component("DmsClientOnly", DmsClientOnly);
  components.forEach(({ component, name }) => {
    app.component(name, component);
  });
  injections.forEach((value, key) => {
    app.provide(key, value);
  });
  plugins.forEach((plugin) => {
    app.use(plugin);
  });
  for (const registration of pluginSetups) {
    if (registration.clientOnly && typeof window === "undefined") continue;
    await app.runWithContext(() => registration.setup(appContext));
  }
  return async () => {
    for (const callback of hooks.get("app:mounted") ?? []) await callback();
  };
}
