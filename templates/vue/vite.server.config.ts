import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { defineConfig, type LogLevel } from "vite";

interface FrontendModuleRegistryEntry {
  id: string;
  root: string;
}

interface FrontendModuleRegistry {
  modules: FrontendModuleRegistryEntry[];
}

const registry = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "generated-frontend-modules.json"),
    "utf8",
  ),
) as FrontendModuleRegistry;
const moduleAliases = Object.fromEntries(
  registry.modules.map((module) => [`@frontend/${module.id}`, module.root]),
);
const stableModuleAliases = Object.fromEntries(
  [...registry.modules].reverse().flatMap((module) => {
    const layersRoot = resolve(module.root, "layers");
    if (existsSync(layersRoot)) {
      return readdirSync(layersRoot).map((name) => [
        `#${name}`,
        resolve(layersRoot, name),
      ]);
    }
    const moduleName = basename(module.root).replace(/^.*__/, "");
    return [[`#${moduleName}`, module.root]];
  }),
);

/** Set by `ajs dms build`, as in vite.config.ts. */
const logLevel = (process.env.DMS_VITE_LOG_LEVEL ?? "info") as LogLevel;

/**
 * The modules' server entries (`dms.server.ts`) and what they import, for the
 * production server. No Vue plugin and no auto-imports: server code imports
 * what it uses, and never the application's own code. npm dependencies stay
 * external and load from the workspace's `node_modules`, as for `dist/ssr`.
 */
export default defineConfig({
  logLevel,
  resolve: {
    alias: {
      "#dms/server": resolve(import.meta.dirname, "server-module.ts"),
      ...stableModuleAliases,
      ...moduleAliases,
    },
  },
  build: {
    outDir: "dist/server-modules",
    ssr: "server-modules.generated.ts",
    emptyOutDir: true,
  },
});
