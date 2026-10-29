import { Link as InertiaLink } from "@inertiajs/vue3";
import {
  useHead as useUnhead,
  useSeoMeta as useUnheadSeoMeta,
} from "@unhead/vue";
import {
  type App,
  type Component,
  type ComponentInternalInstance,
  type ComputedRef,
  defineComponent,
  getCurrentInstance,
  h,
  type InjectionKey,
  inject,
  onMounted,
  type PropType,
  type Ref,
  ref,
} from "vue";
import { useI18n as useVueI18n } from "vue-i18n";
import { type DmsFrontendRuntime } from "./module-registration";
import {
  type DmsAppContext,
  type DmsI18n,
  type DmsLinkPrefetch,
  type DmsNavigationOptions,
  type DmsPluginSetup,
  type RouteLocationRaw,
} from "./types";
import { useDmsRuntime } from "./state";
import { locationToUrl, visit } from "./route";

/**
 * What Vue's development build passes `errorHandler` for an error thrown by a
 * component's `setup`, sync or async (production passes a link instead; it has
 * no warnings to scope either).
 */
export const SETUP_FUNCTION_ERROR = "setup function";
/**
 * Whether a Vue warning comes from a component whose `setup` failed, or from
 * under it. Vue still renders such a component, against the setup state that
 * never came: in development, where a single-file component's template is
 * compiled apart from its setup, the template reads the missing bindings, and
 * every component it uses becomes `undefined` ("Invalid vnode type when
 * creating vnode: undefined", then "Component <Anonymous> is missing template
 * or render function" for the comment Vue renders in its place). The error
 * page replaces that output (a server renders the page again, the browser
 * swaps it), and the failure itself is already reported.
 *
 * Walks internal instances: a `<script setup>` component exposes itself, so
 * its children's `$parent` is an expose proxy, not the proxy `errorHandler`
 * received.
 */
export function withinFailedSetup(
  instance: ComponentInternalInstance | null,
  failedSetups: WeakSet<ComponentInternalInstance>,
): boolean {
  for (let current = instance; current; current = current.parent)
    if (failedSetups.has(current)) return true;
  return false;
}
/** Shows the error page in place of the page, keeping the first failure. */
export function failPage(runtime: DmsFrontendRuntime, reason: unknown): void {
  runtime.currentError.value ??=
    reason instanceof Error ? reason : new Error(String(reason));
}
export function abortDmsNavigation(): false {
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

/** How a keyboard hint prints its modifiers: macOS symbols, or PC key names. */
export type DmsKbdPlatform = "mac" | "other";
/**
 * Where Nuxt UI's key hints read the platform: called in the setup of each
 * component that prints one, it returns the platform that component renders.
 * It must read on the server the platform it renders there, and keep it while
 * its caller hydrates, so the browser's first render matches the server's.
 */
export type DmsKbdPlatformSource = () => Readonly<Ref<DmsKbdPlatform>>;

const KBD_PLATFORM_KEY: InjectionKey<DmsKbdPlatformSource> =
  Symbol("dms:kbd-platform");
const MODIFIER_KBD_KEYS: Record<
  DmsKbdPlatform,
  Record<"meta" | "ctrl" | "alt", string>
> = {
  mac: { meta: "⌘", ctrl: "⌃", alt: "⌥" },
  other: { meta: "Ctrl", ctrl: "Ctrl", alt: "Alt" },
};
const isModifierKbdKey = (value: string): value is "meta" | "ctrl" | "alt" =>
  value === "meta" || value === "ctrl" || value === "alt";

/**
 * Gives Nuxt UI's key hints (`UKbd`, the `kbds` of its menus, the dashboard
 * search button) the application's keyboard platform, so the server prints
 * `meta` as "⌘" or "Ctrl" from the first render instead of a blank the
 * browser fills in after mounting.
 */
export function provideDmsKbdPlatform(
  app: App,
  source: DmsKbdPlatformSource,
): void {
  app.provide(KBD_PLATFORM_KEY, source);
}

interface NuxtUiKbd {
  macOS: ComputedRef<unknown>;
  getKbdKey: (value?: string) => string | undefined;
}

/**
 * Nuxt UI's `useKbd` as the DMS runs it (`ui-kbd.mjs` routes it here): a hint
 * renders the same on the server and in the hydrating browser. Nuxt UI prints
 * `meta`, `ctrl` and `alt` from a map shared by every hint and filled by the
 * first one's `onMounted`, so a hint hydrating after that (in an async
 * component) printed "⌘" over the server's blank. Each hint now keeps the
 * server's value until its own `onMounted`; with a platform provided
 * (`provideDmsKbdPlatform`), that value is the platform's from the start.
 *
 * @internal
 */
export function useDmsKbd(
  shared: () => NuxtUiKbd,
  keys: Readonly<Record<string, string>>,
): NuxtUiKbd {
  const { macOS } = shared();
  const instance = getCurrentInstance();
  const source = instance ? inject(KBD_PLATFORM_KEY, null) : null;
  const platform = source ? source() : null;
  // A hydrating component's vnode is bound to its server node before setup.
  const hydrating = ref(!!instance?.vnode.el);
  if (hydrating.value) onMounted(() => (hydrating.value = false));
  return {
    macOS,
    getKbdKey(value) {
      if (!value) return undefined;
      if (!isModifierKbdKey(value)) return keys[value] || value;
      if (platform) return MODIFIER_KBD_KEYS[platform.value][value];
      if (typeof window === "undefined" || hydrating.value) return " ";
      return MODIFIER_KBD_KEYS[macOS.value ? "mac" : "other"][value];
    },
  };
}

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
