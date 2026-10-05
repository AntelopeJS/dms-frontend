import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ViteDevServer } from "vite";
import { type Component, createRenderer, h, nextTick, ref } from "vue";

interface Node {
  parent: Node | null;
  children: Node[];
}

function headlessRenderer() {
  const node = (): Node => ({ parent: null, children: [] });
  return createRenderer<Node, Node>({
    createElement: node,
    createText: node,
    createComment: node,
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: (child) => child.parent,
    nextSibling: () => null,
    insert(child, parent) {
      child.parent = parent;
      parent.children.push(child);
    },
    remove(child) {
      if (child.parent)
        child.parent.children = child.parent.children.filter(
          (other) => other !== child,
        );
    },
  });
}

function page(language: string, updatedAt: number, accountId = "account-a") {
  return {
    path: `/${language}-${updatedAt}`,
    page: {},
    user: { language },
    session: { accountId, updatedAt },
  };
}

it("takes the interface language from the session, not from a restored page", async () => {
  // Inside the repository, so the runtime's dependencies resolve.
  const workspace = realpathSync(mkdtempSync(resolve(".session-locale-")));
  let server: ViteDevServer | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "frontend-paths.generated.json"), "{}");
    writeFileSync(
      join(workspace, "locales.generated.ts"),
      'export const localeMessages={en:{}};export const supportedLocales=["en","fr","de"];export const loadLocaleMessages=async(locale)=>({locale});export const syncLocaleMessages=()=>{};',
    );
    writeFileSync(
      join(workspace, "ui-stub.ts"),
      "import {h} from 'vue'; const appConfig={}; export const useAppConfig=()=>appConfig;export const useToast=()=>({add(){}});export const en={code:'en'};export const fr={code:'fr'};export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};",
    );

    const { createServer } = await import("vite");
    const { default: vue } = await import("@vitejs/plugin-vue");
    const uiStub = join(workspace, "ui-stub.ts");
    server = await createServer({
      root: workspace,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false },
      plugins: [
        {
          name: "fixture-ui",
          resolveId: (id) => (id.startsWith("@nuxt/ui/") ? uiStub : null),
        },
        vue(),
      ],
    });
    const runtime = await server.ssrLoadModule("/app-runtime.ts");
    const frontend = await server.ssrLoadModule("/frontend-module.ts");
    const { createHead } = await import("@unhead/vue/server");

    const props = ref(page("fr", 2));
    const layout = (runtime.resolveDmsInertiaPage() as { layout: Component })
      .layout;
    const app = headlessRenderer().createApp({
      render: () => h(layout, props.value, { default: () => h("p") }),
    });
    const appRuntime = frontend.createDmsFrontendRuntime();
    // What the browser's runtime is to watchers, which run outside the app.
    frontend.setDmsServerRuntimeResolver(() => appRuntime);
    await runtime.configureDmsApp({
      app,
      head: createHead(),
      initialPageProps: props.value,
      initialPageUrl: props.value.path,
      inertiaPlugin: { install() {} },
      runtime: appRuntime,
    });
    app.mount({ parent: null, children: [] });
    const locale = () => app.config.globalProperties.$i18n.locale.value;
    const settle = async () => {
      await nextTick();
      await new Promise((done) => setTimeout(done));
    };
    assert.equal(locale(), "fr");

    // Back to a page fetched before the user switched to French.
    props.value = page("en", 1);
    await settle();
    assert.equal(locale(), "fr");

    // A page fetched after the session changed again.
    props.value = page("de", 3);
    await settle();
    assert.equal(locale(), "de");

    // Another account signs in, whatever the stamps say.
    props.value = page("en", 1, "account-b");
    await settle();
    assert.equal(locale(), "en");

    app.unmount();
  } finally {
    await server?.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});
