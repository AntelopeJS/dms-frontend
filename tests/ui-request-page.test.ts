import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import type { ViteDevServer } from "vite";

interface RenderProbe {
  /** Holds the first request's page after its app has set up. */
  gate?: Promise<void>;
  waiting?: () => void;
}

interface ServerRenderer {
  renderDmsPage(page: unknown): Promise<{ body: string }>;
}

/**
 * Nuxt UI as the generated workspace installs it, reduced to what matters
 * here: its Inertia Link and route stub, which read Inertia's page with the
 * very lines Nuxt UI 4.10 ships, and a component stub for everything else.
 */
const NUXT_UI_FILES: Record<string, string> = {
  "package.json": JSON.stringify({
    name: "@nuxt/ui",
    type: "module",
    exports: {
      "./vite": "./vite.mjs",
      "./dist/*": "./dist/*",
      "./*": "./stub.mjs",
    },
  }),
  "vite.mjs": "export default () => ({ name: 'fixture-nuxt-ui' });",
  "stub.mjs":
    "import {h} from 'vue'; const appConfig={}; export const useAppConfig=()=>appConfig;export const useToast=()=>({add(){}});export const en={code:'en'};export const fr={code:'fr'};export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};",
  "dist/runtime/vue/overrides/inertia/Link.vue": `<script setup>
import { computed } from "vue";
import { usePage } from "@inertiajs/vue3";
const props = defineProps({ to: { type: String, required: true } });
const page = usePage();
const active = computed(() => page.url === props.to || page.url.startsWith(\`\${props.to}/\`));
</script>
<template><a :href="to" :data-active="active"><slot /></a></template>
`,
  "dist/runtime/vue/stubs/inertia.js": `import { usePage } from "@inertiajs/vue3";
export const useRoute = () => {
  const page = usePage();
  return { get fullPath() { return page.url; } };
};
`,
};

/** A page that suspends on the probe's gate, then renders a link and the route. */
const PAGE = `
import { defineComponent, h, withAsyncContext } from "vue";
import ULink from "@nuxt/ui/components/Link.vue";
import { useRoute } from "@nuxt/ui/dist/runtime/vue/stubs/inertia.js";

export default defineComponent({
  async setup() {
    const probe = globalThis.__dmsUiRequestPage;
    const gate = probe.gate;
    probe.gate = undefined;
    if (gate) {
      let pending;
      let restore;
      [pending, restore] = withAsyncContext(() => (probe.waiting(), gate));
      await pending;
      restore();
    }
    const route = useRoute();
    return () =>
      h("main", [
        h("p", "route:" + route.fullPath),
        h(ULink, { to: "/orders" }, () => "Orders"),
      ]);
  },
});
`;

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function inertiaPage(url: string) {
  return {
    component: "DmsDynamicPage",
    props: { path: url.split("?")[0], page: { componentName: "orders" } },
    url,
    version: "",
  };
}

function seen(body: string) {
  return {
    route: /route:([^<]*)/.exec(body)?.[1],
    ordersLinkActive: /data-active="([^"]*)"/.exec(body)?.[1],
  };
}

it("gives Nuxt UI's Link and route stub their own request's URL while another request renders", async () => {
  // Inside the repository, like the other server render tests, so the
  // renderer's dependencies resolve; with the template's own Vite config.
  const workspace = realpathSync(mkdtempSync(resolve(".ui-request-page-")));
  const probe: RenderProbe = {};
  let server: ViteDevServer | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    for (const [path, content] of Object.entries(NUXT_UI_FILES))
      write(workspace, join("node_modules", "@nuxt", "ui", path), content);
    const moduleRoot = join(workspace, "frontend-modules", "fixture");
    write(moduleRoot, "OrdersPage.ts", PAGE);
    write(
      moduleRoot,
      "dms.frontend.ts",
      'import OrdersPage from "./OrdersPage";\nexport default { setup(sdk) { sdk.registerPage("orders", OrdersPage); } };\n',
    );
    write(
      workspace,
      "frontend-modules.generated.ts",
      'import fixture from "./frontend-modules/fixture/dms.frontend";\nexport const frontendModules = [{ module: fixture, options: { public: {} } }];\n',
    );
    write(
      workspace,
      "generated-frontend-modules.json",
      JSON.stringify({
        modules: [{ id: "fixture", root: moduleRoot, priority: 0 }],
      }),
    );
    write(
      workspace,
      "frontend-builds.generated.ts",
      "export const frontendBuilds = [];\n",
    );
    write(
      workspace,
      "app-configs.generated.ts",
      "export const appConfigs = [];\n",
    );
    write(workspace, "package.json", '{"type":"module"}');
    write(workspace, "frontend-paths.generated.json", "{}");
    write(
      workspace,
      "locales.generated.ts",
      'export const localeMessages={en:{}};export const supportedLocales=["en"];export const loadLocaleMessages=async()=>({});export const syncLocaleMessages=()=>{};',
    );
    Reflect.set(globalThis, "__dmsUiRequestPage", probe);

    const { createServer } = await import("vite");
    server = await createServer({
      root: workspace,
      configFile: join(workspace, "vite.config.ts"),
      logLevel: "silent",
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false, watch: null },
    });
    const renderer = (await server.ssrLoadModule(
      "/ssr-renderer.ts",
    )) as ServerRenderer;

    // The first request suspends once its app has set up; the second renders
    // whole meanwhile, then the first one resumes.
    let release = () => {};
    probe.gate = new Promise<void>((settle) => (release = settle));
    const waiting = new Promise<void>((settle) => (probe.waiting = settle));
    const first = renderer.renderDmsPage(inertiaPage("/dashboard"));
    await waiting;
    const second = await renderer.renderDmsPage(
      inertiaPage("/orders/42?tab=b"),
    );
    release();
    assert.deepEqual(
      [seen((await first).body), seen(second.body)],
      [
        { route: "/dashboard", ordersLinkActive: "false" },
        { route: "/orders/42?tab=b", ordersLinkActive: "true" },
      ],
    );
  } finally {
    await server?.close();
    Reflect.deleteProperty(globalThis, "__dmsUiRequestPage");
    rmSync(workspace, { recursive: true, force: true });
  }
});
