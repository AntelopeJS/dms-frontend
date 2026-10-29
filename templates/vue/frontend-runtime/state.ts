import { ofetch } from "ofetch";
import {
  type App,
  effectScope,
  getCurrentInstance,
  hasInjectionContext,
  type InjectionKey,
  inject,
  onScopeDispose,
  reactive,
  ref,
  shallowReactive,
} from "vue";
import {
  type DmsFrontendRegistry,
  type DmsFrontendRuntime,
  type DmsRuntimeHooks,
} from "./module-registration";
import {
  type DmsAppContext,
  type DmsRoute,
  type DmsRuntimeConfig,
} from "./types";

/** Creates the empty registry one setup of the frontend modules fills. */
export function createDmsFrontendRegistry(): DmsFrontendRegistry {
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
export let registry = createDmsFrontendRegistry();
export const runtimeConfig = ref<DmsRuntimeConfig>({
  public: {},
} as DmsRuntimeConfig);
export const appConfig = ref<Record<string, unknown>>({});
const DMS_RUNTIME_KEY: InjectionKey<DmsFrontendRuntime> = Symbol("dms-runtime");
type DmsRuntimeContext = DmsAppContext["runWithContext"];
export const runtimeContexts = new WeakMap<
  DmsFrontendRuntime,
  DmsRuntimeContext
>();
let serverRuntimeResolver: (() => DmsFrontendRuntime | undefined) | undefined;
let browserRuntime: DmsFrontendRuntime | undefined;

export function replaceRegistry(next: DmsFrontendRegistry): void {
  registry = next;
}

export function forgetBrowserRuntime(runtime: DmsFrontendRuntime): void {
  if (browserRuntime === runtime) browserRuntime = undefined;
}

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

export function useDmsRuntime(): DmsFrontendRuntime {
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
