import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import { defineConfig, type LogLevel, normalizePath, type Plugin } from "vite";

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
 * Inlined verbatim as a module specifier in the generated import, so it has to
 * be POSIX: a native Windows path would reach the parser with its backslashes
 * read as string escapes. See vite.config.ts.
 */
const EMAIL_RUNTIME_IMPORTS = {
  [normalizePath(resolve(import.meta.dirname, "email-runtime.ts"))]: [
    "useDmsAppConfig",
    "useDmsRuntimeConfig",
    "defineDmsAppConfig",
  ],
};

/**
 * Emits each locale catalog as an asset. They are read as data rather than
 * imported: without this, a build in watch mode would keep emitting the
 * catalogs of its first run.
 */
function emailLocaleAssets(): Plugin {
  return {
    name: "dms-email-locale-assets",
    buildStart() {
      const directory = resolve(import.meta.dirname, "locales.generated");
      for (const file of readdirSync(directory).filter((name) =>
        name.endsWith(".json"),
      )) {
        const catalog = resolve(directory, file);
        this.addWatchFile(catalog);
        this.emitFile({
          type: "asset",
          fileName: `locales/${file}`,
          source: readFileSync(catalog, "utf8"),
        });
      }
    },
  };
}

export default defineConfig({
  logLevel,
  plugins: [
    emailLocaleAssets(),
    vue(),
    AutoImport({
      dts: false,
      imports: [EMAIL_RUNTIME_IMPORTS],
    }),
  ],
  resolve: {
    dedupe: ["vue"],
    alias: { ...stableModuleAliases, ...moduleAliases },
  },
  build: {
    manifest: true,
    ssrEmitAssets: true,
    outDir: "dist/server",
    ssr: "email-renderer.ts",
  },
});
