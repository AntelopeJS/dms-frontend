import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import type { ViteDevServer } from "vite";

const TIMEOUT_MS = 15_000;

interface ReloadProbe {
  setups: number;
  plugins: string[];
}

interface ServerRenderer {
  renderDmsPage(page: unknown): Promise<{ body: string }>;
}

async function eventually(done: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("the dev server did not evaluate the server renderer again");
}

/**
 * A frontend module as the DMS layers write one: its page is a `.vue` file
 * loaded on demand, and it registers a plugin.
 */
function writeModule(workspace: string, owner: string, page: string): void {
  const root = join(workspace, "frontend-modules", owner);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "Page.vue"), page);
  writeFileSync(
    join(root, "dms.frontend.ts"),
    `
import { defineAsyncComponent } from "vue";
const probe = globalThis.__dmsDevReload;
const load = () => import("./Page.vue");
export default {
  setup(sdk) {
    if (${JSON.stringify(owner)} === "high") probe.setups += 1;
    sdk.registerPage("page", defineAsyncComponent(async () => (await load()).default), load);
    sdk.registerPlugin(() => { probe.plugins.push(${JSON.stringify(owner)}); });
  },
};
`,
  );
}

it("serves an edited component on the next server render in development", async () => {
  // Inside the repository, like the SSR memory test, so the renderer's
  // dependencies resolve; resolved, because Vite reports a change under the
  // path it resolved.
  const workspace = realpathSync(mkdtempSync(resolve(".ssr-dev-reload-")));
  const probe: ReloadProbe = { setups: 0, plugins: [] };
  let server: ViteDevServer | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "frontend-paths.generated.json"), "{}");
    writeFileSync(
      join(workspace, "locales.generated.ts"),
      'export const localeMessages={en:{}};export const supportedLocales=["en"];export const loadLocaleMessages=async()=>({});export const syncLocaleMessages=()=>{};',
    );
    writeFileSync(
      join(workspace, "ui-stub.ts"),
      "import {h} from 'vue'; const appConfig={}; export const useAppConfig=()=>appConfig;export const useToast=()=>({add(){}});export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};",
    );
    // Both modules claim the page; `high` comes first, as the generated
    // loader orders modules by descending priority.
    writeModule(workspace, "high", "<template><p>high v1</p></template>\n");
    writeModule(workspace, "low", "<template><p>low</p></template>\n");
    writeFileSync(
      join(workspace, "frontend-modules.generated.ts"),
      'import high from "./frontend-modules/high/dms.frontend";\nimport low from "./frontend-modules/low/dms.frontend";\nexport const frontendModules = [{ module: high, options: { public: {} } }, { module: low, options: { public: {} } }];\n',
    );
    Reflect.set(globalThis, "__dmsDevReload", probe);

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
    const devServer = server;

    // What `server.mjs` does for every document request in development: the
    // page it renders, and the plugins the render set up.
    const render = async () => {
      const renderer = (await devServer.ssrLoadModule(
        "/ssr-renderer.ts",
      )) as ServerRenderer;
      probe.plugins = [];
      const { body } = await renderer.renderDmsPage({
        component: "DmsDynamicPage",
        props: { path: "/page", page: {}, errors: {} },
        url: "/page",
        version: "",
      });
      return {
        page: /<p[^>]*>([^<]*)<\/p>/.exec(body)?.[1],
        plugins: probe.plugins,
      };
    };
    // The layer watcher leaves at least 100 ms between two changes to a file,
    // because Vite's file watcher drops a second change to the same file
    // within 50 ms on Linux. Each edit here keeps the same gap.
    const edit = async (text: string) => {
      const setups = probe.setups;
      await new Promise((settle) => setTimeout(settle, 100));
      writeFileSync(
        join(workspace, "frontend-modules", "high", "Page.vue"),
        `<template><p>${text}</p></template>\n`,
      );
      await eventually(async () => {
        await devServer.ssrLoadModule("/ssr-renderer.ts");
        return probe.setups > setups;
      });
    };

    assert.deepEqual(await render(), {
      page: "high v1",
      plugins: ["high", "low"],
    });
    await edit("high v2");
    assert.deepEqual(await render(), {
      page: "high v2",
      plugins: ["high", "low"],
    });
    await edit("high v3");
    assert.deepEqual(await render(), {
      page: "high v3",
      plugins: ["high", "low"],
    });
  } finally {
    await server?.close();
    Reflect.deleteProperty(globalThis, "__dmsDevReload");
    rmSync(workspace, { recursive: true, force: true });
  }
});
