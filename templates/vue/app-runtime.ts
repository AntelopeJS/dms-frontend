import UApp from "@nuxt/ui/components/App.vue";
import UIcon from "@nuxt/ui/runtime/vue/components/Icon.vue";
import { useAppConfig } from "@nuxt/ui/runtime/vue/composables/useAppConfig";
import ui from "@nuxt/ui/vue-plugin";
import { useHead } from "@unhead/vue";
import type { VueHeadClient } from "@unhead/vue/types";
import { defu } from "defu";
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
  createDmsFrontendRuntime,
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
} from "./frontend-module";
import {
  loadLocaleMessages,
  localeMessages,
  supportedLocales,
} from "./locales.generated";

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

function pageLocale(props: DmsPageProps): string {
  const language = props.user?.language;
  if (typeof language !== "string") return DEFAULT_LOCALE;
  const locale = language.slice(0, 2);
  return supportedLocales.includes(locale) ? locale : DEFAULT_LOCALE;
}

function readDmsAsyncData(): Record<string, unknown> {
  if (typeof document === "undefined") return {};
  const element = document.getElementById(SSR_ASYNC_DATA_ID);
  if (!element?.textContent) return {};
  const data = JSON.parse(element.textContent) as Record<string, unknown>;
  element.remove();
  return data;
}

function readDmsAsyncComponents(): string[] {
  if (typeof document === "undefined") return [];
  const element = document.getElementById(SSR_ASYNC_COMPONENTS_ID);
  if (!element?.textContent) return [];
  const names = JSON.parse(element.textContent) as string[];
  element.remove();
  return names;
}

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
    let localeVersion = 0;
    useHead({
      htmlAttrs: { lang: computed(() => i18n.locale.value) },
    });
    watch(
      () => [attrs.path, attrs.page, attrs.user, attrs.session, attrs.error],
      async () => {
        const version = ++localeVersion;
        hydrateDmsPageProps(props.value);
        const locale = pageLocale(props.value);
        if (i18n.locale.value === locale) return;
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
  return h(Suspense, null, { default: () => pageContent });
}

function renderDmsPersistentLayout(
  props: DmsPageProps,
  error: DmsPageProps["error"],
  children: VNode[] | undefined,
  overlays: string[],
) {
  const layout = error ? undefined : getDmsLayout(props);
  const content = layout
    ? h(layout, getDmsLayoutProps(props), { default: () => children })
    : children;
  return h(
    UApp,
    { portal: "#dms-overlays" },
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

export async function configureDmsApp(
  options: DmsAppOptions,
): Promise<DmsConfiguredApp> {
  const uiAppConfig = useAppConfig();
  Object.assign(uiAppConfig, defu(useDmsAppConfig(), uiAppConfig));
  const runtime =
    options.runtime ??
    createDmsFrontendRuntime(
      options.serverFetch as typeof import("ofetch").ofetch,
      readDmsAsyncData(),
    );
  const locale = pageLocale(options.initialPageProps);
  const messages = await loadLocaleMessages(locale);
  const i18n = createI18n({
    legacy: false,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    messages: { ...localeMessages, [locale]: messages },
  });
  provideDmsFrontendRuntime(options.app, runtime);
  options.app.component("Icon", UIcon);
  options.app.use(options.inertiaPlugin).use(options.head).use(ui).use(i18n);
  options.app.runWithContext(() =>
    hydrateDmsPageProps(options.initialPageProps, options.initialPageUrl),
  );
  // Resolve, before the app mounts, every async component the server
  // rendered: the page, its layout, and the components the render reached.
  // Hydration then adopts the server-rendered markup instead of discarding it.
  await Promise.all([
    preloadDmsPage(options.initialPageProps),
    resolveDmsAsyncComponents(readDmsAsyncComponents()),
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
