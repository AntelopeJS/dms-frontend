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

function isRegistryEntry(value: unknown): value is FrontendModuleRegistryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "root" in value &&
    typeof value.root === "string"
  );
}

function isRegistry(value: unknown): value is FrontendModuleRegistry {
  return (
    typeof value === "object" &&
    value !== null &&
    "modules" in value &&
    Array.isArray(value.modules) &&
    value.modules.every(isRegistryEntry)
  );
}

function readRegistry(path: string): FrontendModuleRegistry {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRegistry(parsed))
    throw new TypeError(`${path} is not a frontend module registry.`);
  return parsed;
}

const registry = readRegistry(
  resolve(import.meta.dirname, "generated-frontend-modules.json"),
);
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

/** The levels Vite logs at. */
const LOG_LEVELS = [
  "info",
  "warn",
  "error",
  "silent",
] as const satisfies readonly LogLevel[];

function logLevelOf(value: string | undefined): LogLevel {
  return LOG_LEVELS.find((level) => level === value) ?? "info";
}

/** Set by `ajs dms build`, as in vite.config.ts. */
const logLevel = logLevelOf(process.env.DMS_VITE_LOG_LEVEL);

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
