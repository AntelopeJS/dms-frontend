import { usePage } from "@inertiajs/vue3";
import {
  type Component,
  type EffectScope,
  type InjectionKey,
  type Plugin,
  type Ref,
} from "vue";
import type { DmsPublicOptionsById } from "../public-options";
import {
  type DmsAppContext,
  type DmsAsyncData,
  type DmsComponentPreloader,
  type DmsComponentRegistrationOptions,
  type DmsErrorData,
  type DmsMiddlewareRegistrationOptions,
  type DmsModuleOptions,
  type DmsPluginRegistrationOptions,
  type DmsPluginSetup,
  type DmsRoute,
  type DmsServerFetch,
  type DmsSharedPagePayload,
  type RouteLocationRaw,
} from "./types";

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
  /** The module's id in the generated module registry. */
  id?: string;
  /** The module's manifest name, which collision warnings name it by. */
  name?: string;
  module: DmsFrontendModule;
  options: DmsModuleOptions;
}

/**
 * The registrations with the public options the server runs with in place of
 * the build's: `ajs dms start` computes them from the project's configuration
 * and the deployment's variables. Unset, the build's options stand.
 */
export function withPublicOptions(
  registrations: DmsFrontendModuleRegistration[],
  byId: DmsPublicOptionsById | undefined,
): DmsFrontendModuleRegistration[] {
  if (!byId) return registrations;
  return registrations.map((registration) => {
    const options = registration.id ? byId[registration.id] : undefined;
    return options
      ? {
          ...registration,
          options: { ...registration.options, public: options },
        }
      : registration;
  });
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

export interface DmsComponentRegistration {
  name: string;
  component: Component;
  /** The registering module, for a collision warning. */
  module?: string;
  /** Registered without the module's prefix, to replace another module's. */
  unprefixed?: boolean;
}

export interface DmsFrontendEntry {
  component: Component;
  preload?: DmsComponentPreloader;
}

export interface DmsAsyncComponent {
  __asyncLoader?: DmsComponentPreloader;
}

interface DmsPluginRegistration {
  setup: DmsPluginSetup;
  clientOnly: boolean;
  enforce: NonNullable<DmsPluginRegistrationOptions["enforce"]>;
}

export const PLUGIN_ORDER = { pre: 0, default: 1, post: 2 } as const;

/**
 * What the frontend modules registered through their SDK. Modules are set up
 * by descending priority, so the first one to claim a name keeps it.
 */
export interface DmsFrontendRegistry {
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
  serverFetch?: DmsServerFetch;
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
