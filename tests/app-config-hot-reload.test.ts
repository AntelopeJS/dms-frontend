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
import { after, before, describe, it } from "node:test";
import type { ViteDevServer } from "vite";
import { toRaw } from "vue";
import {
  createFrontendModuleRegistry,
  getLayerSafeName,
  getLayerWorkspacePath,
  materializeLayers,
  type ResolvedLayer,
  writeAppConfigs,
  writeFrontendModuleRegistry,
} from "../src/common";

type AppConfig = Record<string, any>;

interface HotReloadProbe {
  evaluations: number;
}

const TIMEOUT_MS = 15_000;
const RUNTIME_FILES = [
  "frontend-module.ts",
  "layer-app-config.ts",
  "ui-app-config.ts",
];

async function eventually(done: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("the dev server did not pick the edited app config up");
}

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function configSource(config: AppConfig): string {
  return `export default ${JSON.stringify(config)};\n`;
}

/**
 * The generated app configs module in a real Vite dev server, as `ajs-dms dev`
 * runs it: the browser side is played by a module runner with HMR, which
 * applies updates with the same client the browser uses, and the server side
 * by `ssrLoadModule`, which is how the generated server renders pages. Both
 * set the modules up from the configs as `main.ts` and `ssr-renderer.ts` do.
 */
describe("edited layer app configs in the dev server", () => {
  const root = realpathSync(mkdtempSync(resolve(".app-config-hmr-")));
  const workspace = join(root, "workspace");
  const project: ResolvedLayer = {
    path: join(root, "sources", "project"),
    packageName: "@fixture/project",
    priority: 10,
  };
  const dms: ResolvedLayer = {
    path: join(root, "sources", "dms"),
    packageName: "@fixture/dms",
    priority: 1,
  };
  const layers = [project, dms];
  const projectConfig = join(
    getLayerWorkspacePath(workspace, project),
    "app",
    "app.config.ts",
  );
  const dmsLayers = join(getLayerWorkspacePath(workspace, dms), "layers");
  const probe: HotReloadProbe = { evaluations: 0 };
  let server: ViteDevServer;

  const edit = async (path: string, config: AppConfig): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFile(path, configSource(config));
  };

  before(async () => {
    for (const layer of layers)
      writeFile(
        join(layer.path, "package.json"),
        JSON.stringify({ name: layer.packageName }),
      );
    writeFile(
      join(project.path, "app", "app.config.ts"),
      configSource({ branding: { name: "Project" } }),
    );
    writeFile(
      join(dms.path, "layers", "dms-layout", "app", "app.config.ts"),
      configSource({
        branding: { name: "DMS", logo: "/dms.svg" },
        ui: { colors: { primary: "dms", neutral: "neutral" } },
      }),
    );
    mkdirSync(workspace);
    materializeLayers(workspace, layers);
    writeFrontendModuleRegistry(workspace, layers);
    for (const file of RUNTIME_FILES)
      cpSync(join("templates", "vue", file), join(workspace, file));
    writeFileSync(
      join(workspace, "server-entry.ts"),
      'import { appConfigs } from "./app-configs.generated";\nimport { setupFrontendModules, useDmsAppConfig } from "./frontend-module";\nawait setupFrontendModules([], appConfigs);\nexport const appConfig = useDmsAppConfig();\n',
    );
    writeFileSync(
      join(workspace, "client-entry.ts"),
      'import { appConfigs, syncAppConfigs } from "./app-configs.generated";\nimport { setupFrontendModules, updateDmsAppConfig, useDmsAppConfig } from "./frontend-module";\nglobalThis.__dmsAppConfigHmr.evaluations += 1;\nawait setupFrontendModules([{ options: { public: {} }, module: { setup() { useDmsAppConfig().addedBySetup = true; } } }], appConfigs);\nsyncAppConfigs(updateDmsAppConfig);\nexport const appConfig = useDmsAppConfig();\n',
    );
    Reflect.set(globalThis, "__dmsAppConfigHmr", probe);
    const { createServer } = await import("vite");
    server = await createServer({
      root: workspace,
      configFile: false,
      logLevel: "silent",
      appType: "custom",
      optimizeDeps: { noDiscovery: true },
      server: { middlewareMode: true, ws: false },
      resolve: {
        alias: Object.fromEntries(
          layers.map((layer) => [
            `@frontend/${getLayerSafeName(layer)}`,
            getLayerWorkspacePath(workspace, layer),
          ]),
        ),
      },
    });
  });

  after(async () => {
    await server?.close();
    Reflect.deleteProperty(globalThis, "__dmsAppConfigHmr");
    rmSync(root, { recursive: true, force: true });
  });

  it("sets the next server render up from the edited config", async () => {
    const render = async (): Promise<AppConfig> =>
      toRaw((await server.ssrLoadModule("/server-entry.ts")).appConfig);
    assert.deepEqual((await render()).branding, {
      name: "Project",
      logo: "/dms.svg",
    });
    await edit(projectConfig, { branding: { name: "Project (server)" } });
    await eventually(
      async () => (await render()).branding.name === "Project (server)",
    );
    assert.equal((await render()).branding.logo, "/dms.svg");
  });

  it("updates the running app's config in place, without reloading it", async () => {
    const { createServerModuleRunner } = await import("vite");
    const runner = createServerModuleRunner(server.environments.ssr, {
      hmr: { logger: false },
    });
    const invalidated: string[] = [];
    server.environments.ssr.hot.on("vite:invalidate", (payload) => {
      invalidated.push(payload.path);
    });
    try {
      const { appConfig } = (await runner.import("/client-entry.ts")) as {
        appConfig: AppConfig;
      };
      const branding = appConfig.branding;
      assert.equal(probe.evaluations, 1);

      await edit(projectConfig, {
        branding: { name: "Edited", logo: "/branding/logo-1a2b.png" },
        ui: { colors: { primary: "green" } },
      });
      await eventually(() => appConfig.branding.name === "Edited");
      assert.equal(appConfig.branding, branding);
      assert.equal(branding.logo, "/branding/logo-1a2b.png");
      assert.deepEqual(toRaw(appConfig.ui.colors), {
        primary: "green",
        neutral: "neutral",
      });
      assert.equal(appConfig.addedBySetup, true);

      await edit(projectConfig, { branding: { name: "Edited again" } });
      await eventually(() => appConfig.branding.name === "Edited again");
      assert.equal(branding.logo, "/dms.svg");

      await edit(join(dmsLayers, "dms-theme", "app", "app.config.ts"), {
        branding: { logo: "/theme.svg" },
        ui: { colors: { neutral: "zinc" } },
      });
      writeAppConfigs(
        workspace,
        createFrontendModuleRegistry(workspace, layers),
      );
      await eventually(() => appConfig.ui.colors.neutral === "zinc");
      assert.equal(branding.logo, "/theme.svg");
      assert.equal(appConfig.ui.colors.primary, "dms");

      assert.equal(probe.evaluations, 1);
      assert.deepEqual(invalidated, []);
    } finally {
      await runner.close();
    }
  });
});
