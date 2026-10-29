import { type InertiaLinkProps } from "@inertiajs/vue3";
import { type FetchOptions, ofetch } from "ofetch";
import {
  type App,
  type ComputedRef,
  type MaybeRefOrGetter,
  type Ref,
  watch,
} from "vue";
import type { Composer } from "vue-i18n";
import { type $fetch } from "./fetch";

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
export type DmsLinkPrefetch =
  | boolean
  | DmsLinkPrefetchMode
  | DmsLinkPrefetchMode[];
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
  /**
   * When the plugin runs, as Nuxt's `enforce`: every module's `"pre"`
   * plugins first, then the `"default"` ones, then the `"post"` ones, each
   * group in the modules' priority order. A plugin that the others depend on
   * whatever their module's priority, such as the one setting the async data
   * scope (`setDmsAsyncDataScope`), is `"pre"`.
   */
  enforce?: "pre" | "default" | "post";
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
