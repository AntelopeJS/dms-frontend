// The layers' app configs: each asset root of each module may hold an
// `app/app.config.ts`, which the application merges into `useDmsAppConfig()`
// before any module is set up, and the email renderer into the config of each
// email.
//
// Split out of derived-outputs.ts, whose size the linter caps.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { affectsAssetDirectory, moduleAssetRoots } from "./asset-roots";
import { applyContent } from "./fs-sync";

/**
 * Where an asset root keeps its app config. TypeScript only: the generated
 * module that imports every one of them is type-checked with the workspace,
 * which does not allow JavaScript.
 */
const APP_CONFIG_FILE = "app/app.config.ts";
const APP_CONFIGS_MODULE = "app-configs.generated.ts";

/** The part of the module registry the app configs are found from. */
interface AppConfigModules {
  modules: ReadonlyArray<{ id: string; root: string }>;
}

interface LayerAppConfigFile {
  moduleId: string;
  /** Relative to the module root, with POSIX separators. */
  relativePath: string;
}

/**
 * Every layer's app config, highest precedence first: modules in the
 * registry's order, by descending priority, and within a module its layers
 * from the last by name to the first, so that the last one wins, as it does a
 * contested public file.
 */
function discoverAppConfigs(registry: AppConfigModules): LayerAppConfigFile[] {
  return registry.modules.flatMap((module) =>
    moduleAssetRoots(module.root)
      .reverse()
      .filter((root) => existsSync(join(root.absolutePath, APP_CONFIG_FILE)))
      .map((root) => ({
        moduleId: module.id,
        relativePath: `${root.relativePrefix}${APP_CONFIG_FILE}`,
      })),
  );
}

/**
 * The module through which the application, the server renderer and the email
 * renderer import every layer's app config. It imports nothing else at run
 * time, the email bundle above all must not pull the browser runtime in: a
 * layer's config auto-imports `defineDmsAppConfig` from `frontend-module.ts`, and
 * the runtime never imports this module either, which would make a cycle.
 *
 * In development this module accepts its own hot updates, as the locale module
 * does: an edited config, or one added or removed, which regenerates this
 * module, reaches the open page through `syncAppConfigs`, whose listeners
 * outlive each instance through `import.meta.hot.data`. Accepting itself
 * rather than the configs matters to the server renderer: Vite stops
 * invalidating importers at a module that accepts the changed import, which
 * would leave the next server render, and its setup of the modules, on the old
 * configs.
 */
function appConfigModuleSource(configs: LayerAppConfigFile[]): string {
  const imports = configs.map(
    (config, index) =>
      `import config${index} from "@frontend/${config.moduleId}/${config.relativePath}";`,
  );
  const entries = configs.map(
    (config, index) =>
      `{ module: ${JSON.stringify(config.moduleId)}, config: config${index} }`,
  );
  return `${imports.join("\n")}

import type { DmsLayerAppConfig } from "./frontend-module";

type AppConfigsListener = (appConfigs: DmsLayerAppConfig[]) => void;

/** Every layer's \`app/app.config.ts\`, highest precedence first. */
export const appConfigs: DmsLayerAppConfig[] = [${entries.join(", ")}];
const listeners: Set<AppConfigsListener> =
  import.meta.hot?.data.listeners ?? new Set();

/** Development only: hands \`listener\` the configs of every hot update. */
export function syncAppConfigs(listener: AppConfigsListener): void {
  if (import.meta.hot) listeners.add(listener);
}

if (import.meta.hot) {
  import.meta.hot.data.listeners = listeners;
  import.meta.hot.accept((next) => {
    if (next) for (const listener of listeners) listener(next.appConfigs);
  });
}
`;
}

/** Write the module that imports every layer's app config. */
export function writeAppConfigs(
  workspaceDir: string,
  registry: AppConfigModules,
): boolean {
  return applyContent(
    appConfigModuleSource(discoverAppConfigs(registry)),
    join(workspaceDir, APP_CONFIGS_MODULE),
  );
}

/** Whether a change at `relativePath` can add or remove a layer's app config. */
export function affectsAppConfigs(relativePath: string): boolean {
  return affectsAssetDirectory(APP_CONFIG_FILE, relativePath);
}
