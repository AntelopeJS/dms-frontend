import "./dms-main.css";
import { createInertiaApp } from "@inertiajs/vue3";
import { createHead } from "@unhead/vue/client";
import { createApp, createSSRApp, h } from "vue";
import { configureDmsApp, resolveDmsInertiaPage } from "./app-runtime";
import { setupFrontendModules } from "./frontend-module";
import { frontendModules } from "./frontend-modules.generated";

function markDmsReady(): void {
  document.documentElement.dataset.dmsReady = "true";
}

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
