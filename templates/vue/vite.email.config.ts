import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import vue from "@vitejs/plugin-vue";
import AutoImport from "unplugin-auto-import/vite";
import { defineConfig, normalizePath } from "vite";

interface FrontendModuleRegistryEntry {
  id: string;
  root: string;
}

interface FrontendModuleRegistry {
  modules: FrontendModuleRegistryEntry[];
}

const registry = JSON.parse(
  readFileSync(resolve(__dirname, "generated-frontend-modules.json"), "utf8"),
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

export default defineConfig({
  plugins: [
    {
      name: "dms-email-locale-assets",
      buildStart() {
        const directory = resolve(__dirname, "locales.generated");
        for (const file of readdirSync(directory).filter((name) =>
          name.endsWith(".json"),
        )) {
          this.emitFile({
            type: "asset",
            fileName: `locales/${file}`,
            source: readFileSync(resolve(directory, file), "utf8"),
          });
        }
      },
    },
    vue(),
    AutoImport({
      dts: false,
      imports: [
        {
          // Inlined verbatim as a module specifier in the generated import, so
          // it has to be POSIX: a native Windows path would reach the parser
          // with its backslashes read as string escapes. See vite.config.ts.
          [normalizePath(resolve(__dirname, "email-runtime.ts"))]: [
            "useDmsAppConfig",
            "useDmsRuntimeConfig",
            "defineAppConfig",
          ],
        },
      ],
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
