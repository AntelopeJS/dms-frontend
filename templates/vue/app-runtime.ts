import UApp from "@nuxt/ui/components/App.vue";
import UIcon from "@nuxt/ui/runtime/vue/components/Icon.vue";
import { useToast } from "@nuxt/ui/composables/useToast";
import { useAppConfig } from "@nuxt/ui/runtime/vue/composables/useAppConfig";
import { en as uiEn, fr as uiFr } from "@nuxt/ui/locale";
import ui from "@nuxt/ui/vue-plugin";
import { useHead } from "@unhead/vue";
import type { VueHeadClient } from "@unhead/vue/types";
import type { IconifyIcon } from "@iconify/vue";
import type { FetchOptions } from "ofetch";
import {
  type App,
  type Component,
  computed,
  defineComponent,
  h,
  type Plugin,
  Suspense,
  type VNode,
  watch,
} from "vue";
import { createI18n, useI18n } from "vue-i18n";
import DmsDynamicPage from "./DmsDynamicPage.vue";
import {
  type DmsLocaleLoader,
  type DmsPageProps,
  type DmsUser,
  createDmsFrontendRuntime,
  dmsPageSuspenseProps,
  getDmsErrorPage,
  getDmsLayout,
  getDmsLayoutProps,
  getDmsPage,
  hydrateDmsPageProps,
  installDmsPlugins,
  preloadDmsPage,
  provideDmsFrontendRuntime,
  resolveDmsAsyncComponents,
  resolveDmsComponent,
  serializeDmsAsyncData,
  trackDmsAsyncComponents,
  useDmsAppConfig,
  useDmsState,
  useError,
  useUserSession,
} from "./frontend-module";
import {
  SSR_ICONS_ID,
  addDmsIcons,
  drawLoadedIconsAtOnce,
} from "./icon-hydration";
import {
  loadLocaleMessages,
  localeMessages,
  supportedLocales,
  syncLocaleMessages,
} from "./locales.generated";
import { showNetworkErrors } from "./network-error";
import { createUiAppConfigMerger } from "./ui-app-config";

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
  mounted: () => Promise<void>;
  runtime: ReturnType<typeof createDmsFrontendRuntime>;
}

export type DmsServerFetch = (
  request: string,
  options?: FetchOptions,
) => Promise<unknown>;

const SSR_ASYNC_DATA_ID = "dms-ssr-async-data";
export const SSR_ASYNC_COMPONENTS_ID = "dms-ssr-async-components";
const DEFAULT_LOCALE = "en";

/**
 * Nuxt UI ships its own strings (placeholders, empty states, aria labels).
 * Only the locales the DMS translates are imported: the full catalog would
 * weigh on every bundle. A locale missing here falls back to English.
 */
const UI_LOCALES = { en: uiEn, fr: uiFr };

type UiLocale = (typeof UI_LOCALES)[keyof typeof UI_LOCALES];

function uiLocale(locale: string): UiLocale {
  return UI_LOCALES[locale as keyof typeof UI_LOCALES] ?? UI_LOCALES.en;
}

/** The supported locale of a user's language, if it has one. */
function userLocale(user: DmsUser | null | undefined): string | undefined {
  const language = user?.language;
  if (typeof language !== "string") return undefined;
  const locale = language.slice(0, 2);
  return supportedLocales.includes(locale) ? locale : undefined;
}

function readServerRendered<T>(id: string, empty: T): T {
  if (typeof document === "undefined") return empty;
  const element = document.getElementById(id);
  if (!element?.textContent) return empty;
  const value = JSON.parse(element.textContent) as T;
  element.remove();
  return value;
}

drawLoadedIconsAtOnce();

const DmsInertiaPage = defineComponent({
  name: "DmsInertiaPage",
  inheritAttrs: false,
  setup(_, { attrs }) {
    const props = computed(() => attrs as unknown as DmsPageProps);
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

const DmsPersistentLayout = defineComponent({
  name: "DmsPersistentLayout",
  inheritAttrs: false,
  setup(_, { attrs, slots }) {
    const props = computed(() => attrs as unknown as DmsPageProps);
    const i18n = useI18n();
    const { user } = useUserSession();
    let localeVersion = 0;
    useHead({
      htmlAttrs: { lang: computed(() => i18n.locale.value) },
    });
    watch(
      () => [attrs.path, attrs.page, attrs.user, attrs.session, attrs.error],
      () => hydrateDmsPageProps(props.value),
      { immediate: true, flush: "sync" },
    );
    // The session, not the page props: a page restored from history or from
    // the prefetch cache carries the user as it was when it was fetched, and
    // would switch the interface back to a language the user has left. A
    // session without a language keeps the one on screen.
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
    const currentError = useError();
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

export function resolveDmsInertiaPage(): Component {
  return DmsPersistentInertiaPage;
}

function renderDmsPage(
  props: DmsPageProps,
  capturedError: DmsPageProps["error"] = useError().value,
) {
  const error = capturedError ?? props.error;
  const page = error
    ? (getDmsErrorPage() ?? DmsDynamicPage)
    : (getDmsPage(props) ?? DmsDynamicPage);
  const pageContent = h(page as Component, {
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

function mergeDmsAppConfig(): void {
  mergeUiAppConfig(useAppConfig(), useDmsAppConfig());
}

export async function configureDmsApp(
  options: DmsAppOptions,
): Promise<DmsConfiguredApp> {
  mergeDmsAppConfig();
  const runtime =
    options.runtime ??
    createDmsFrontendRuntime(
      options.serverFetch as typeof import("ofetch").ofetch,
      readServerRendered<Record<string, unknown>>(SSR_ASYNC_DATA_ID, {}),
    );
  const locale = userLocale(options.initialPageProps.user) ?? DEFAULT_LOCALE;
  const messages = await loadLocaleMessages(locale);
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages: { ...localeMessages, [locale]: messages },
  });
  // A translation changed in a layer during development reaches the page
  // without a reload. A server render imports the new catalogs instead.
  if (typeof window !== "undefined") syncLocaleMessages(i18n.global);
  provideDmsFrontendRuntime(options.app, runtime);
  options.app.component("Icon", UIcon);
  options.app.use(options.inertiaPlugin).use(options.head).use(ui).use(i18n);
  options.app.runWithContext(() =>
    hydrateDmsPageProps(options.initialPageProps, options.initialPageUrl),
  );
  addDmsIcons(
    readServerRendered<Record<string, IconifyIcon>>(SSR_ICONS_ID, {}),
  );
  if (typeof window !== "undefined") {
    const toast = options.app.runWithContext(() => useToast());
    showNetworkErrors(toast.add, i18n.global);
  }
  // Resolve, before the app mounts, every async component the server
  // rendered: the page, its layout, and the components the render reached.
  // Hydration then adopts the server-rendered markup instead of discarding it.
  await Promise.all([
    preloadDmsPage(options.initialPageProps),
    resolveDmsAsyncComponents(
      readServerRendered<string[]>(SSR_ASYNC_COMPONENTS_ID, []),
    ),
  ]);
  const mounted = await installDmsPlugins(
    options.app,
    i18n.global,
    runtime,
    loadLocaleMessages as DmsLocaleLoader,
    supportedLocales,
  );
  return { mounted, runtime };
}

export { serializeDmsAsyncData, trackDmsAsyncComponents };
