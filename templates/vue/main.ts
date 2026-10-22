import "./dms-main.css";
import { addAPIProvider } from "@iconify/vue";
import { createInertiaApp } from "@inertiajs/vue3";
import { createHead } from "@unhead/vue/client";
import { createApp, createSSRApp, h } from "vue";
import { appConfigs, syncAppConfigs } from "./app-configs.generated";
import {
  applyLayerAppConfigs,
  configureDmsApp,
  resolveDmsInertiaPage,
} from "./app-runtime";
import { setupFrontendModules, withPublicOptions } from "./frontend-module";
import { parsePublicOptions } from "./public-options";
import { frontendModules } from "./frontend-modules.generated";
import { sameOriginIconProvider } from "./icon-api.mjs";

const DEV_STYLE_ATTRIBUTE = "data-dms-dev-style";
/** Mirrors `PUBLIC_OPTIONS_ELEMENT_ID` in `server/public-options.mjs`. */
const PUBLIC_OPTIONS_ELEMENT_ID = "dms-public-options";

/**
 * Hand each development stylesheet over to Vite.
 *
 * The development server puts the page's stylesheets in the document so it
 * never paints unstyled (see `server/dev-styles.mjs`). Vite then injects its
 * own copy of each one as a `<style data-vite-dev-id>`, and keeping both would
 * make a later CSS edit look like it removed nothing: Vite rewrites its copy,
 * ours keeps the deleted rules alive.
 *
 * We drop ours the moment Vite's appears, keyed by module id, rather than at a
 * fixed point in the boot. A component reached through a dynamic import — most
 * of them — has not been loaded when the app mounts, so removing its scoped
 * rules then would flash exactly what this whole change exists to prevent.
 */
function adoptViteDevStyles(): void {
  const pending = new Map<string, Element>();
  for (const node of document.querySelectorAll(`[${DEV_STYLE_ATTRIBUTE}]`)) {
    pending.set(node.getAttribute(DEV_STYLE_ATTRIBUTE) ?? "", node);
  }
  if (pending.size === 0) return;
  const adopt = (): void => {
    for (const style of document.querySelectorAll("style[data-vite-dev-id]")) {
      const id = style.getAttribute("data-vite-dev-id") ?? "";
      pending.get(id)?.remove();
      pending.delete(id);
    }
    if (pending.size === 0) observer.disconnect();
  };
  const observer = new MutationObserver(adopt);
  observer.observe(document.head, { childList: true });
  adopt();
}

function markDmsReady(): void {
  document.documentElement.dataset.dmsReady = "true";
}

if (import.meta.env.DEV) adoptViteDevStyles();
// Before any module or component can render an icon the client bundle lacks:
// the generated server answers those queries from the installed collections.
addAPIProvider("", sameOriginIconProvider(location.origin));

/**
 * Sets the modules up, then starts the app.
 *
 * A function rather than top-level statements: Rollup keeps apart every module
 * the entry shares with a dynamic import when the entry awaits at its top level
 * (merging them could deadlock that await). Every page and component is such
 * an import, so the bundle split the entry into a hundred one-module chunks the
 * browser requested one by one.
 */
async function startDmsApp(): Promise<void> {
  const runtimeOptions = parsePublicOptions(
    document.getElementById(PUBLIC_OPTIONS_ELEMENT_ID)?.textContent,
  );
  await setupFrontendModules(
    withPublicOptions(frontendModules, runtimeOptions),
    appConfigs,
  );
  // A layer's app config edited during development reaches the page without a
  // reload. A server render imports the new configs instead.
  syncAppConfigs(applyLayerAppConfigs);

  createInertiaApp({
    resolve: resolveDmsInertiaPage,
    async setup({ App, el, props, plugin }) {
      const root = { render: () => h(App, props) };
      const app = el.hasAttribute("data-server-rendered")
        ? createSSRApp(root)
        : createApp(root);
      const configured = await configureDmsApp({
        app,
        head: createHead(),
        initialPageProps: props.initialPage.props,
        initialPageUrl: props.initialPage.url,
        inertiaPlugin: plugin,
      });
      app.mount(el);
      markDmsReady();
      await configured.mounted();
    },
  });
}

void startDmsApp();
