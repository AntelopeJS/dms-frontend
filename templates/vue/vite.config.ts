import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import { defineConfig, normalizePath, type Plugin } from "vite";
import { orderHeadForFirstPaint } from "./head-order.mjs";

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
/**
 * Globs are POSIX, always.
 *
 * `resolve` returns a native path, so on Windows every pattern below would
 * carry backslashes — which a glob matcher reads as escape characters, not as
 * separators, and which therefore match nothing at all. `normalizePath` is
 * Vite's own answer to this and is the identity function on POSIX.
 */
const importDirectories = frontendSourceRoots.flatMap((root) =>
  [
    "app/composables/**/*",
    "app/types/**/*",
    "app/utils/**/*",
    "app/build/composables/**/*",
    "app/build/types/**/*",
  ].map((glob) => ({ glob: normalizePath(resolve(root, glob)), types: true })),
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

/**
 * Entry points the dependency optimizer crawls at startup.
 *
 * Every materialized module brings its own dependency set — subpath exports and
 * transitive CommonJS included — and none of it can be listed in
 * `optimizedDependencies` by hand, because the modules are only known at
 * materialization time. Leaving the crawl off and letting Vite discover them as
 * pages load meant the first visit to a cold page re-ran the optimizer
 * mid-request: the chunks already in flight answered 504 and the client was
 * told to reload the whole document. Crawling the module sources once, at
 * startup, pays that cost a single time and in a place where it reads as
 * startup rather than as a crash.
 *
 * Normalized for the same reason as `importDirectories`: Vite hands these
 * patterns straight to its glob matcher without touching the separators.
 */
const optimizerEntries = [
  resolve(__dirname, "main.ts"),
  ...moduleRoots.map((root) => resolve(root, "dms.frontend.ts")),
  ...frontendSourceRoots.flatMap((root) => [
    resolve(root, "app/**/*.vue"),
    resolve(root, "app/**/*.ts"),
  ]),
].map(normalizePath);

function paintBeforeHydrate(): Plugin {
  return {
    name: "dms-paint-before-hydrate",
    apply: "build",
    enforce: "post",
    transformIndexHtml: { order: "post", handler: orderHeadForFirstPaint },
  };
}

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
            // This key is inlined verbatim as the module specifier of the
            // import the auto-importer prepends to each file. A native Windows
            // path would land inside a single-quoted JavaScript string with its
            // backslashes intact, where `\U`, `\M` and `\f` are read as escape
            // sequences: the specifier the bundler then resolves is a mangled
            // path that cannot exist. Keep it POSIX.
            [normalizePath(resolve(__dirname, "frontend-module.ts"))]: [
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
    paintBeforeHydrate(),
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
    entries: optimizerEntries,
  },
  ssr: { noExternal: ["@nuxt/icon", "@nuxt/ui"] },
  server: { strictPort: true, allowedHosts: [".onamp.dev"] },
  build: { manifest: true, outDir: "dist/client" },
});
