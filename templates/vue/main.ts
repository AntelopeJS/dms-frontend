import "./dms-main.css";
import { createInertiaApp } from "@inertiajs/vue3";
import { createHead } from "@unhead/vue/client";
import { createApp, createSSRApp, h } from "vue";
import { configureDmsApp, resolveDmsInertiaPage } from "./app-runtime";
import { setupFrontendModules } from "./frontend-module";
import { frontendModules } from "./frontend-modules.generated";

const DEV_STYLE_ATTRIBUTE = "data-dms-dev-style";

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

await setupFrontendModules(frontendModules);

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
