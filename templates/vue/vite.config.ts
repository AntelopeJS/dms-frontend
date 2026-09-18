import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

interface FrontendModuleRegistryEntry {
  id: string;
  root: string;
  priority: number;
}

interface FrontendModuleRegistry {
  modules: FrontendModuleRegistryEntry[];
}

const registryPath = resolve(__dirname, "generated-frontend-modules.json");
const registry = JSON.parse(
  readFileSync(registryPath, "utf8"),
) as FrontendModuleRegistry;
const moduleRoots = registry.modules.map((module) => module.root);
const frontendSourceRoots = moduleRoots.flatMap((root) => {
  const layersRoot = resolve(root, "layers");
  if (!existsSync(layersRoot)) return [root];
  return readdirSync(layersRoot).map((name) => resolve(layersRoot, name));
});
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
const importDirectories = frontendSourceRoots.flatMap((root) =>
  [
    "app/composables/**/*",
    "app/types/**/*",
    "app/utils/**/*",
    "app/build/composables/**/*",
    "app/build/types/**/*",
  ].map((glob) => ({ glob: resolve(root, glob), types: true })),
);
const optimizedDependencies = [
  "vue",
  "@inertiajs/vue3",
  "@unhead/vue",
  "@unhead/vue/client",
  "vue-i18n",
  "@vueuse/core",
  "reka-ui",
  "@internationalized/date",
  "vuedraggable",
  "vue3-apexcharts",
  "apexcharts",
  "tailwind-variants",
  "ofetch",
  "ufo",
  "defu",
  "zod",
  "json-schema-to-zod",
  "striptags",
];
const uiLinkImport = "@nuxt/ui/components/Link.vue";
const uiInertiaLinkImport = resolve(
  __dirname,
  "node_modules/@nuxt/ui/dist/runtime/vue/overrides/inertia/Link.vue",
);

export default defineConfig({
  plugins: [
    {
      name: "dms-ui-inertia-link",
      enforce: "pre",
      resolveId(id) {
        return id === uiLinkImport ? uiInertiaLinkImport : null;
      },
    },
    vue(),
    ui({
      router: "inertia",
      icon: { clientBundle: { scan: true } },
      components: { dirs: [] },
      autoImport: {
        dirs: importDirectories,
        dirsScanOptions: { types: true },
        imports: [
          "vue",
          {
            [resolve(__dirname, "frontend-module.ts")]: [
              "$fetch",
              "abortNavigation",
              "clearError",
              "createError",
              "defineAppConfig",
              "defineDmsPlugin",
              "defineDmsMiddleware",
              "defineDmsPageMeta",
              "navigateDms",
              "prefetchComponents",
              "preloadComponents",
              "refreshDmsData",
              "showError",
              "useDmsAsyncData",
              "useDmsCookie",
              "useColorMode",
              "useDmsFetch",
              "useHead",
              "useI18n",
              "useError",
              "useDmsLazyAsyncData",
              "useDmsApp",
              "useDmsRoute",
              "useDmsRouter",
              "useDmsRuntimeConfig",
              "useSeoMeta",
              "useDmsState",
              "useDmsAppConfig",
              "DmsClientOnly",
              "DmsLink",
              "useUserSession",
            ],
          },
        ],
        dts: "auto-imports.d.ts",
        vueTemplate: true,
      },
    }),
  ],
  resolve: {
    dedupe: ["vue", "reka-ui", "@nuxt/ui"],
    alias: {
      "#dms/frontend-module": resolve(__dirname, "frontend-module.ts"),
      "#build/nuxt-icon-client-bundle": "virtual:nuxt-ui-icons",
      "#shortcuts-aggregated": resolve(
        __dirname,
        "shortcuts-aggregated.generated.ts",
      ),
      ...stableModuleAliases,
      ...Object.fromEntries(
        registry.modules.map((module) => [
          `@frontend/${module.id}`,
          module.root,
        ]),
      ),
    },
  },
  optimizeDeps: {
    include: optimizedDependencies,
    // Avoid crawling every module page at startup, but optimize dependencies as pages load.
    entries: [],
  },
  ssr: { noExternal: ["@nuxt/icon", "@nuxt/ui"] },
  server: { strictPort: true, allowedHosts: [".onamp.dev"] },
  build: { manifest: true, outDir: "dist/client" },
});
