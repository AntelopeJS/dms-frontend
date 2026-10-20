import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import ui from "@nuxt/ui/vite";
import vue from "@vitejs/plugin-vue";
import {
  createLogger,
  defineConfig,
  type LogLevel,
  normalizePath,
  type Plugin,
} from "vite";
import { clientCodeSplitting, onBuildLog } from "./client-chunking.mjs";
import { rejectServerSourcesInClient } from "./client-server-guard.mjs";
import { uiInertiaPage } from "./ui-inertia-page.mjs";
import { uiRequestState } from "./ui-request-state.mjs";
import { autoImportDirectories } from "./frontend-build-loader.ts";
import { frontendBuilds } from "./frontend-builds.generated.ts";
import { orderHeadForFirstPaint } from "./head-order.mjs";
import { iconScanGlobs } from "./icon-scan.mjs";

interface FrontendModuleRegistryEntry {
  id: string;
  root: string;
  priority: number;
}

interface FrontendModuleRegistry {
  modules: FrontendModuleRegistryEntry[];
}

const registryPath = resolve(
  import.meta.dirname,
  "generated-frontend-modules.json",
);
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
 * `ajs dms build` runs Vite at "warn" and reports the steps itself; a verbose
 * run, `dev` and a hand-run build keep Vite's own output.
 */
const logLevel = (process.env.DMS_VITE_LOG_LEVEL ?? "info") as LogLevel;
const logger = createLogger(logLevel);
/**
 * Only what each module declares in its `dms.frontend.build.ts`: a module
 * without one has nothing auto-imported.
 */
const importDirectories = autoImportDirectories(
  registry.modules,
  frontendBuilds,
  (message) => logger.warn(message),
);
/**
 * Dependencies pre-bundled by name. A module's own dependencies need no entry:
 * the startup crawl below (`optimizerEntries`) finds them in its sources. A
 * name no module installs any more only earns a "Failed to resolve
 * dependency" warning at every start.
 */
const optimizedDependencies = [
  "vue",
  "@inertiajs/vue3",
  "@unhead/vue",
  "@unhead/vue/client",
  "vue-i18n",
  "@vueuse/core",
  "reka-ui",
  "@internationalized/date",
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
 * Globs are POSIX, always: `resolve` returns a native path, whose Windows
 * backslashes a glob matcher reads as escape characters, not as separators.
 * `normalizePath` is Vite's own answer to this, the identity on POSIX.
 */
const optimizerEntries = [
  resolve(import.meta.dirname, "main.ts"),
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
  import.meta.dirname,
  "node_modules/@nuxt/ui/dist/runtime/vue/overrides/inertia/Link.vue",
);
/**
 * Nuxt UI's Link and route stub read Inertia's page to know the current URL.
 * Inertia keeps a single page for the whole process, written by each server
 * render as it starts: a link rendered after an await could take another
 * request's URL to set its active state. Their `usePage()` is the DMS one,
 * which gives the page of the request being rendered. Likewise, their
 * `useState()` (the toasts among others) is the DMS's per-application state,
 * not one record for the whole process.
 */
const isNuxtUiFile = (id: string) =>
  normalizePath(id).includes("/node_modules/@nuxt/ui/");

export default defineConfig({
  logLevel,
  plugins: [
    // Fails a client build that imports a dms.server.ts or a file under a
    // module's server/ directory, however it is imported.
    rejectServerSourcesInClient(moduleRoots),
    {
      name: "dms-ui-inertia-link",
      enforce: "pre",
      resolveId(id) {
        return id === uiLinkImport ? uiInertiaLinkImport : null;
      },
    },
    uiInertiaPage(isNuxtUiFile),
    uiRequestState(isNuxtUiFile),
    vue(),
    ui({
      router: "inertia",
      icon: {
        clientBundle: {
          scan: {
            globInclude: iconScanGlobs(
              import.meta.dirname,
              frontendSourceRoots,
            ),
          },
        },
      },
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
            [normalizePath(resolve(import.meta.dirname, "frontend-module.ts"))]:
              [
                "$fetch",
                "abortDmsNavigation",
                "clearDmsError",
                "createDmsError",
                "dmsRequestKey",
                "defineDmsAppConfig",
                "defineDmsPlugin",
                "defineDmsMiddleware",
                "defineDmsPageMeta",
                "navigateDms",
                "preloadDmsComponents",
                "refreshDmsData",
                "refreshDmsPageData",
                "setDmsAsyncDataScope",
                "showDmsError",
                "useDmsAsyncData",
                "useDmsData",
                "useDmsCookie",
                "useDmsRequestHeader",
                "useDmsFetch",
                "useHead",
                "useI18n",
                "useDmsError",
                "useDmsPagedData",
                "useDmsPageLoading",
                "useDmsApp",
                "useDmsRoute",
                "useDmsRouter",
                "useDmsRuntimeConfig",
                "useSeoMeta",
                "useDmsState",
                "useDmsAppConfig",
                "DmsClientOnly",
                "DmsLink",
                "useDmsUserSession",
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
    // `@iconify/vue` keeps its API providers in module state: `main.ts` and
    // Nuxt UI's `Icon` must share one copy for the same-origin provider to apply.
    dedupe: ["vue", "reka-ui", "@nuxt/ui", "@vueuse/core", "@iconify/vue"],
    alias: {
      "#dms/frontend-module": resolve(
        import.meta.dirname,
        "frontend-module.ts",
      ),
      // For the server's development loader only: no browser module imports
      // a `dms.server.ts`.
      "#dms/server": resolve(import.meta.dirname, "server-module.ts"),
      "#build/nuxt-icon-client-bundle": "virtual:nuxt-ui-icons",
      "#shortcuts-aggregated": resolve(
        import.meta.dirname,
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
  build: {
    manifest: true,
    outDir: "dist/client",
    rolldownOptions: { onLog: onBuildLog },
  },
  // The browser bundle only: the server bundles are single Node programs, for
  // which a file count means nothing.
  environments: {
    client: {
      build: {
        rolldownOptions: { output: { codeSplitting: clientCodeSplitting } },
      },
    },
  },
});
