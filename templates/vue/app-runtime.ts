import UApp from "@nuxt/ui/components/App.vue";
import UIcon from "@nuxt/ui/runtime/vue/components/Icon.vue";
import { useToast } from "@nuxt/ui/composables/useToast";
import { useAppConfig } from "@nuxt/ui/runtime/vue/composables/useAppConfig";
import { en as uiEn, fr as uiFr } from "@nuxt/ui/locale";
import ui from "@nuxt/ui/vue-plugin";
import { router } from "@inertiajs/vue3";
import { useHead } from "@unhead/vue";
import type { VueHeadClient } from "@unhead/vue/types";
import type { IconifyIcon } from "@iconify/vue";
import { parse } from "devalue";
import {
  type App,
  type Component,
  computed,
  type ComputedRef,
  defineComponent,
  h,
  type Plugin,
  type Ref,
  type SetupContext,
  Suspense,
  type VNode,
  watch,
} from "vue";
import { createI18n, useI18n } from "vue-i18n";
import DmsDynamicPage from "./DmsDynamicPage.vue";
import {
  type DmsErrorData,
  type DmsFrontendRuntime,
  type DmsLayerAppConfig,
  type DmsPageProps,
  type DmsPayload,
  type DmsServerFetch,
  type DmsUser,
  createDmsFrontendRuntime,
  dmsPageSuspenseProps,
  getDmsErrorPage,
  getDmsLayout,
  getDmsLayoutProps,
  getDmsPage,
  hydrateDmsPageProps,
  hydrateDmsSharedProps,
  installDmsPlugins,
  keepSharedOverHistory,
  preloadDmsPage,
  preloadPrefetchedDmsPages,
  provideDmsFrontendRuntime,
  readDmsLocaleCookie,
  resolveDmsAsyncComponents,
  resolveDmsComponent,
  restoreDmsPayload,
  trackDmsAsyncComponents,
  updateDmsAppConfig,
  useDmsAppConfig,
  useDmsState,
  useDmsError,
  useDmsUserSession,
} from "./frontend-module";
import {
  SSR_ICONS_ID,
  addDmsIcons,
  drawLoadedIconsAtOnce,
} from "./icon-hydration";
import {
  catalogLocale,
  loadLocaleMessages,
  localeMessages,
  supportedLocales,
  syncLocaleMessages,
} from "./locales.generated";
import {
  type DmsMessageSubset,
  type MessageGroup,
  SSR_MESSAGES_ID,
  parseMessageSubset,
  recordMessageReads,
} from "./message-subset";
import {
  type DmsNetworkErrorTranslator,
  NETWORK_ERROR_KEYS,
  showNetworkErrors,
} from "./network-error";
import { loadIconBundle } from "./icon-bundle";
import {
  createUiAppConfigMerger,
  isPlainRecord,
  type PlainRecord,
} from "./ui-app-config";

export interface DmsInertiaSetupProps {
  initialPage: unknown;
  initialComponent: Component;
  resolveComponent: (name: string) => Promise<Component>;
  titleCallback?: (title: string) => string;
  onHeadUpdate?: (elements: string[]) => void;
}

export interface DmsAppOptions {
  app: App;
  head: VueHeadClient;
  initialPageProps: DmsPageProps;
  initialPageUrl: string;
  inertiaPlugin: Plugin;
  runtime?: DmsFrontendRuntime;
  serverFetch?: DmsServerFetch;
}

export interface DmsConfiguredApp {
  /**
   * The locale of the catalog the app shows its messages from now, none when
   * the page is served the messages it read alone.
   */
  catalogLocale: () => string | undefined;
  /**
   * On the server, for a page of a visitor who is not signed in: the messages
   * the render read, which the page carries instead of the whole catalog.
   */
  messageSubset: () => DmsMessageSubset | undefined;
  mounted: () => Promise<void>;
  runtime: ReturnType<typeof createDmsFrontendRuntime>;
}

export const DMS_PAYLOAD_ID = "dms-payload";
export const SSR_ASYNC_COMPONENTS_ID = "dms-ssr-async-components";
const DEFAULT_LOCALE = "en";

type UiLocale = typeof uiEn;

/**
 * Nuxt UI ships its own strings (placeholders, empty states, aria labels).
 * Only the locales the DMS translates are imported: the full catalog would
 * weigh on every bundle. A locale missing here falls back to English.
 */
const UI_LOCALES = new Map<string, UiLocale>([
  ["en", uiEn],
  ["fr", uiFr],
]);

function uiLocale(locale: string): UiLocale {
  return UI_LOCALES.get(locale) ?? uiEn;
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

function isFlag(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOptional<T>(
  value: T | undefined,
  check: (candidate: T) => boolean,
): boolean {
  return value === undefined || check(value);
}

function isErrorData(value: unknown): value is DmsErrorData {
  return (
    isRecord(value) &&
    isOptional(value.statusCode, isNumber) &&
    isOptional(value.statusMessage, isText) &&
    isOptional(value.message, isText) &&
    isOptional(value.fatal, isFlag)
  );
}

function isPayload(value: unknown): value is DmsPayload {
  return (
    isRecord(value) &&
    isRecord(value.data) &&
    isRecord(value.state) &&
    isRecord(value.errors) &&
    Object.values(value.errors).every(isErrorData)
  );
}

function isIcon(value: unknown): value is IconifyIcon {
  return (
    isRecord(value) &&
    isText(value.body) &&
    isOptional(value.left, isNumber) &&
    isOptional(value.top, isNumber) &&
    isOptional(value.width, isNumber) &&
    isOptional(value.height, isNumber) &&
    isOptional(value.rotate, isNumber) &&
    isOptional(value.hFlip, isFlag) &&
    isOptional(value.vFlip, isFlag)
  );
}

function isIcons(value: unknown): value is Record<string, IconifyIcon> {
  return isRecord(value) && Object.values(value).every(isIcon);
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isText);
}

function parsePayload(text: string): DmsPayload | undefined {
  const parsed: unknown = parse(text);
  return isPayload(parsed) ? parsed : undefined;
}

function parseIcons(text: string): Record<string, IconifyIcon> | undefined {
  const parsed: unknown = JSON.parse(text);
  return isIcons(parsed) ? parsed : undefined;
}

function parseNames(text: string): string[] | undefined {
  const parsed: unknown = JSON.parse(text);
  return isNames(parsed) ? parsed : undefined;
}

/** The supported locale of a user's language, if it has one. */
function userLocale(user: DmsUser | null | undefined): string | undefined {
  const language = user?.language;
  if (!isText(language)) return undefined;
  const locale = language.slice(0, 2);
  return supportedLocales.includes(locale) ? locale : undefined;
}

/**
 * The signed-in user's language, else the one this browser picked, which is
 * how a visitor's choice on a public page survives a reload.
 */
function initialLocale(
  user: DmsUser | undefined,
  runtime: DmsFrontendRuntime,
): string {
  return (
    userLocale(user) ??
    readDmsLocaleCookie(runtime, supportedLocales) ??
    DEFAULT_LOCALE
  );
}

/**
 * What the server rendered into the element `id`, parsed by `parseText`, which
 * answers `undefined` for anything it does not recognize. The element is
 * removed once read.
 */
function readServerRendered<T>(
  id: string,
  parseText: (text: string) => T | undefined,
): T | undefined {
  if (typeof document === "undefined") return undefined;
  const element = document.getElementById(id);
  if (!element?.textContent) return undefined;
  const value = parseText(element.textContent);
  element.remove();
  return value;
}

drawLoadedIconsAtOnce();

/**
 * A browser runtime, started from what the server rendered, if it did: when
 * the server did not render the page, nothing is restored, since there is no
 * hydration then.
 */
function createBrowserRuntime(
  serverFetch?: DmsServerFetch,
): DmsConfiguredApp["runtime"] {
  const runtime = createDmsFrontendRuntime(serverFetch);
  const payload = readServerRendered(DMS_PAYLOAD_ID, parsePayload);
  if (payload) restoreDmsPayload(runtime, payload);
  return runtime;
}

type PageAttrs = SetupContext["attrs"];

function pagePropsOf(attrs: PageAttrs): DmsPageProps {
  return attrs as unknown as DmsPageProps;
}

const DmsInertiaPage = defineComponent({
  name: "DmsInertiaPage",
  inheritAttrs: false,
  setup(_, { attrs }) {
    const props = computed(() => pagePropsOf(attrs));
    watch(
      () => [attrs.path, attrs.page, attrs.error],
      () => {
        void preloadDmsPage(props.value);
      },
      { immediate: true },
    );
    const { t } = useI18n();
    useHead({
      title: computed(() => {
        const title = props.value.page.route?.displayName;
        return title?.startsWith("$") ? t(title.slice(1)) : title;
      }),
    });
    return () => renderDmsPage(props.value);
  },
});

/**
 * Hydrates the site layout apart from the page: a reload of the site layout
 * alone (`router.reload({ only: ["shared"] })`) is not a navigation.
 */
function hydrateSharedOnReload(
  attrs: PageAttrs,
  props: ComputedRef<DmsPageProps>,
): void {
  watch(
    () => attrs.shared,
    () => hydrateDmsSharedProps(props.value.shared),
    { flush: "sync" },
  );
}

interface LocaleSwitcher {
  locale: { value: string };
  setLocaleMessage(locale: string, messages: MessageGroup): void;
}

/**
 * Switches the interface to the language of the session, not of the page
 * props: a page restored from history or from the prefetch cache carries the
 * user as it was when it was fetched, and would switch the interface back to a
 * language the user has left. A session without a language keeps the one on
 * screen.
 */
function followSessionLocale(
  user: Ref<DmsUser | null>,
  i18n: LocaleSwitcher,
): void {
  let localeVersion = 0;
  watch(
    () => userLocale(user.value),
    async (locale) => {
      const version = ++localeVersion;
      if (!locale || i18n.locale.value === locale) return;
      const messages = await loadLocaleMessages(locale);
      if (version !== localeVersion) return;
      i18n.setLocaleMessage(locale, messages);
      i18n.locale.value = locale;
    },
    { immediate: true, flush: "sync" },
  );
}

const DmsPersistentLayout = defineComponent({
  name: "DmsPersistentLayout",
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    const props = computed(() => pagePropsOf(attrs));
    const i18n = useI18n();
    const { user } = useDmsUserSession();
    useHead({
      htmlAttrs: { lang: computed(() => i18n.locale.value) },
    });
    watch(
      () => [attrs.path, attrs.page, attrs.user, attrs.session, attrs.error],
      () => hydrateDmsPageProps(props.value),
      { immediate: true, flush: "sync" },
    );
    hydrateSharedOnReload(attrs, props);
    followSessionLocale(user, i18n);
    const currentError = useDmsError();
    const overlays = useDmsState<string[]>("dms-app-overlays", () => []);
    return () => {
      const error = currentError.value ?? props.value.error;
      const content = error
        ? [renderDmsPage(props.value, error)]
        : slots.default?.();
      return renderDmsPersistentLayout(
        props.value,
        error,
        content,
        overlays.value,
        i18n.locale.value,
      );
    };
  },
});

const DmsPersistentInertiaPage = Object.assign(DmsInertiaPage, {
  layout: DmsPersistentLayout,
});

/**
 * What a visit waits for before it shows its page, set when the first one
 * starts from a page that began without what the pages after it read: a
 * subset of the catalog, the icon bundle. Inertia also resolves the first page
 * once the app is set up, which must not wait for it.
 */
let completeInitialAssets: (() => Promise<void>) | undefined;

export function resolveDmsInertiaPage(): Component | Promise<Component> {
  return completeInitialAssets
    ? completeInitialAssets().then(() => DmsPersistentInertiaPage)
    : DmsPersistentInertiaPage;
}

function renderDmsPage(
  props: DmsPageProps,
  capturedError: DmsPageProps["error"] = useDmsError().value,
) {
  const error = capturedError ?? props.error;
  const page: Component = error
    ? (getDmsErrorPage() ?? DmsDynamicPage)
    : (getDmsPage(props) ?? DmsDynamicPage);
  const pageContent = h(page, {
    ...props,
    error,
    key: props.path,
  });
  return h(Suspense, dmsPageSuspenseProps(), { default: () => pageContent });
}

function renderDmsPersistentLayout(
  props: DmsPageProps,
  error: DmsPageProps["error"],
  children: VNode[] | undefined,
  overlays: string[],
  locale: string,
) {
  const layout = error ? undefined : getDmsLayout(props);
  const content = layout
    ? h(layout, getDmsLayoutProps(props), { default: () => children })
    : children;
  return h(
    UApp,
    { portal: "#dms-overlays", locale: uiLocale(locale) },
    {
      default: () => [
        ...overlays.map((name) =>
          h(resolveDmsComponent(name) ?? name, { key: name }),
        ),
        content,
      ],
    },
  );
}

const mergeUiAppConfig = createUiAppConfigMerger();

function readUiAppConfig(): PlainRecord {
  const config: unknown = useAppConfig();
  if (!isPlainRecord(config))
    throw new Error("Nuxt UI's app config is not a record");
  return config;
}

function mergeDmsAppConfig(): void {
  mergeUiAppConfig(readUiAppConfig(), useDmsAppConfig());
}

/**
 * Development only: applies the layers' app configs, edited while the page is
 * open, to the DMS app config and to Nuxt UI's, both in place, so the
 * components reading them and Nuxt UI's colors follow without a reload.
 */
export function applyLayerAppConfigs(appConfigs: DmsLayerAppConfig[]): void {
  updateDmsAppConfig(appConfigs);
  mergeUiAppConfig(readUiAppConfig(), useDmsAppConfig(), { isChanged: true });
}

/**
 * For an anonymous visitor in the browser: completes what the page began
 * without (the rest of the catalog, the icon bundle) on the first visit, and
 * the icon bundle alone on the first interaction.
 */
function completeAssetsOnFirstVisit(
  loadCatalog: (() => Promise<void>) | undefined,
): void {
  const complete = async (): Promise<void> => {
    await Promise.all([loadCatalog?.(), loadIconBundle()]);
  };
  router.on("before", () => {
    completeInitialAssets = complete;
    void complete();
  });
  for (const type of ["pointerdown", "keydown", "focusin", "touchstart"])
    addEventListener(type, () => void loadIconBundle(), {
      once: true,
      capture: true,
    });
}

/**
 * What only the browser does once the app is set up: it follows a translation
 * changed in a layer during development without a reload (a server render
 * imports the new catalogs instead), tells the visitor of a visit that never
 * reached the server, and preloads the pages the browser prefetched.
 */
function startBrowserFeatures(
  app: App,
  i18n: DmsNetworkErrorTranslator & Parameters<typeof syncLocaleMessages>[0],
): void {
  syncLocaleMessages(i18n);
  const toast = app.runWithContext(() => useToast());
  showNetworkErrors(toast.add, i18n);
  preloadPrefetchedDmsPages();
  app.runWithContext(keepSharedOverHistory);
}

/**
 * Resolves, before the app mounts, every async component the server rendered:
 * the page, its layout, and the components the render reached. Hydration then
 * adopts the server-rendered markup instead of discarding it.
 */
async function resolveRenderedComponents(
  options: DmsAppOptions,
  anonymous: boolean,
): Promise<void> {
  await Promise.all([
    anonymous ? undefined : loadIconBundle(),
    preloadDmsPage(options.initialPageProps),
    resolveDmsAsyncComponents(
      readServerRendered(SSR_ASYNC_COMPONENTS_ID, parseNames) ?? [],
    ),
  ]);
}

export async function configureDmsApp(
  options: DmsAppOptions,
): Promise<DmsConfiguredApp> {
  mergeDmsAppConfig();
  const runtime = options.runtime ?? createBrowserRuntime(options.serverFetch);
  const locale = initialLocale(options.initialPageProps.user, runtime);
  const anonymous = !options.initialPageProps.user;
  const subset = anonymous
    ? readServerRendered(SSR_MESSAGES_ID, parseMessageSubset)
    : undefined;
  const started = subset?.locale === locale ? subset : undefined;
  const messages = started?.messages ?? (await loadLocaleMessages(locale));
  const recorder =
    anonymous && typeof window === "undefined"
      ? recordMessageReads(messages)
      : undefined;
  let loading: Promise<void> | undefined;
  const i18n = createI18n<[MessageGroup], string, false>({
    legacy: false,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages: started
      ? { [locale]: messages }
      : { ...localeMessages, [locale]: recorder?.messages ?? messages },
    ...(started && {
      missing: (_locale: string, key: string) => {
        if (i18n.global.locale.value !== locale) return key;
        void loadCompleteCatalog();
        return "";
      },
    }),
  });
  function loadCompleteCatalog(): Promise<void> {
    if (i18n.global.locale.value !== locale) return Promise.resolve();
    loading ??= loadLocaleMessages(locale).then(
      (complete) => {
        i18n.global.setLocaleMessage(locale, complete);
        i18n.global.setMissingHandler(null);
      },
      () => {
        loading = undefined;
      },
    );
    return loading;
  }
  if (anonymous && typeof window !== "undefined")
    completeAssetsOnFirstVisit(started ? loadCompleteCatalog : undefined);
  if (recorder) for (const key of NETWORK_ERROR_KEYS) i18n.global.te(key);
  provideDmsFrontendRuntime(options.app, runtime);
  options.app.component("Icon", UIcon);
  options.app.use(options.inertiaPlugin).use(options.head).use(ui).use(i18n);
  options.app.runWithContext(() =>
    hydrateDmsPageProps(options.initialPageProps, options.initialPageUrl),
  );
  addDmsIcons(readServerRendered(SSR_ICONS_ID, parseIcons) ?? {});
  if (typeof window !== "undefined")
    startBrowserFeatures(options.app, i18n.global);
  await resolveRenderedComponents(options, anonymous);
  const mounted = await installDmsPlugins(
    options.app,
    i18n.global,
    runtime,
    loadLocaleMessages,
    supportedLocales,
  );
  return {
    catalogLocale: () =>
      recorder ? undefined : catalogLocale(i18n.global.locale.value),
    messageSubset: () => recorder && { locale, messages: recorder.subset() },
    mounted,
    runtime,
  };
}

export { trackDmsAsyncComponents };
