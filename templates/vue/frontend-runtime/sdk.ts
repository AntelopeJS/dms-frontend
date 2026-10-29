import { router as inertiaRouter } from "@inertiajs/vue3";
import { defu } from "defu";
import {
  type App,
  type AppConfig,
  type Component,
  type ComponentInternalInstance,
  camelize,
  capitalize,
  computed,
  getCurrentInstance,
  type InjectionKey,
  inject,
} from "vue";
import type { Composer } from "vue-i18n";
import {
  appConfigChanges,
  assignInPlace,
  mergeLayerAppConfigs,
  withAppConfigChanges,
} from "../layer-app-config";
import {
  type DmsFrontendEntry,
  type DmsFrontendModuleRegistration,
  type DmsFrontendRegistry,
  type DmsFrontendRuntime,
  type DmsFrontendSdk,
  type DmsLayerAppConfig,
  PLUGIN_ORDER,
} from "./module-registration";
import {
  type DmsAppContext,
  type DmsComponentPreloader,
  type DmsI18n,
  type DmsLocaleLoader,
  type PublicRuntimeConfig,
} from "./types";
import {
  normalizeDmsName,
  normalizeDmsPageKey,
  registerDmsComponentEntry,
} from "./components";
import {
  appConfig,
  createDmsFrontendRegistry,
  forgetBrowserRuntime,
  registry,
  replaceRegistry,
  runtimeConfig,
} from "./state";
import {
  DmsClientOnly,
  DmsLink,
  failPage,
  SETUP_FUNCTION_ERROR,
  withinFailedSetup,
} from "./ui";
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, writeCookie } from "./cookies";

// What the last setup of the modules changed in the layers' app configs, which
// a development update of those configs keeps: see `updateDmsAppConfig`.
let appConfigSetupChanges: Record<string, unknown> = {};

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
        enforce: options.enforce ?? "default",
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
  replaceRegistry(next);
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
      forgetBrowserRuntime(runtime);
    });
  }
  const failedSetups = new WeakSet<ComponentInternalInstance>();
  const warnOutsideFailedSetups: AppConfig["warnHandler"] = (
    message,
    instance,
    trace,
  ) => {
    // The comment Vue renders in place of an `undefined` component has no
    // public instance: the template rendering it is the one that failed.
    const source = instance?.$ ?? getCurrentInstance();
    if (!withinFailedSetup(source, failedSetups))
      console.warn(`[Vue warn]: ${message}${trace ? `\n${trace}` : ""}`);
  };
  app.config.errorHandler = (reason, instance, info) => {
    if (instance && info === SETUP_FUNCTION_ERROR) {
      failedSetups.add(instance.$);
      // From the first failure on only: until then Vue keeps its own output,
      // whose component trace shows the props. An app that already has a
      // handler keeps it. A server renders a single page per app; in the
      // browser the app outlives Inertia visits, so once a page has failed
      // the handler stays for the session and later warnings print as plain
      // text (no inspectable objects), still all of them.
      app.config.warnHandler ??= warnOutsideFailedSetups;
    }
    failPage(runtime, reason);
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
  // Stable: within a group, the modules' priority order stays.
  const pluginSetups = [...registry.pluginSetups].sort(
    (left, right) => PLUGIN_ORDER[left.enforce] - PLUGIN_ORDER[right.enforce],
  );
  for (const registration of pluginSetups) {
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
