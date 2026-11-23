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
import { clientOutput, onBuildLog } from "./client-chunking.mjs";
import { recordEntryWeight } from "./entry-weight.mjs";
import { rejectBackendSources } from "./backend-boundary.mjs";
import { rejectServerSourcesInClient } from "./client-server-guard.mjs";
import { uiInertiaPage } from "./ui-inertia-page.mjs";
import { uiKbd } from "./ui-kbd.mjs";
import { uiLazyIcons } from "./ui-lazy-icons.mjs";
import { uiRequestState } from "./ui-request-state.mjs";
import { autoImportDirectories, vitePlugins } from "./frontend-build-loader.ts";
import { autoImportSources } from "./auto-imports.mjs";
import { frontendBuilds } from "./frontend-builds.generated.ts";
import { orderHeadForFirstPaint } from "./head-order.mjs";
import { iconScanGlobs } from "./icon-scan.mjs";
import {
  sfcGlobalTypesWatcher,
  writeSfcGlobalTypes,
} from "./sfc-global-types.mjs";

interface FrontendModuleRegistryEntry {
  id: string;
  name?: string;
  packageName?: string;
  backendPackage?: string;
  root: string;
  priority: number;
}

interface FrontendModuleRegistry {
  modules: FrontendModuleRegistryEntry[];
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isRegistryEntry(value: unknown): value is FrontendModuleRegistryEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    "root" in value &&
    typeof value.root === "string" &&
    "priority" in value &&
    typeof value.priority === "number" &&
    isOptionalText("name" in value ? value.name : undefined) &&
    isOptionalText("packageName" in value ? value.packageName : undefined) &&
    isOptionalText("backendPackage" in value ? value.backendPackage : undefined)
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

const registryPath = resolve(
  import.meta.dirname,
  "generated-frontend-modules.json",
);
const registry = readRegistry(registryPath);
const moduleRoots = registry.modules.map((module) => module.root);
const backendPackages = registry.modules.flatMap((module) =>
  module.backendPackage === undefined ? [] : [module.backendPackage],
);
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

/**
 * `ajs dms build` runs Vite at "warn" and reports the steps itself; a verbose
 * run, `dev` and a hand-run build keep Vite's own output.
 */
const logLevel = logLevelOf(process.env.DMS_VITE_LOG_LEVEL);
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
 * The auto-imported types, as declarations Vue's SFC compiler reads: without
 * them a prop typed with one compiles to the wrong runtime type.
 */
const sfcGlobalTypesFile = resolve(
  import.meta.dirname,
  "sfc-global-types.generated.d.ts",
);
await writeSfcGlobalTypes(
  importDirectories,
  import.meta.dirname,
  sfcGlobalTypesFile,
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

/**
 * `@iconify/vue` keeps its API providers in module state: `main.ts` and Nuxt
 * UI's `Icon` must share one copy for the same-origin provider to apply.
 */
const DEDUPED_PACKAGES = [
  "vue",
  "reka-ui",
  "@nuxt/ui",
  "@vueuse/core",
  "@iconify/vue",
];

/**
 * For the server's development loader only: no browser module imports a
 * `dms.server.ts`.
 */
const SERVER_MODULE_ALIAS = resolve(import.meta.dirname, "server-module.ts");

/**
 * The browser bundle only: the server bundles are single Node programs, for
 * which a file count means nothing.
 */
const CLIENT_ENVIRONMENT = {
  build: {
    rolldownOptions: { output: clientOutput },
  },
};

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
    rejectServerSourcesInClient(moduleRoots),
    rejectBackendSources(backendPackages),
    recordEntryWeight(registry.modules),
    {
      name: "dms-ui-inertia-link",
      enforce: "pre",
      resolveId(id) {
        return id === uiLinkImport ? uiInertiaLinkImport : null;
      },
    },
    uiKbd(isNuxtUiFile),
    uiLazyIcons(isNuxtUiFile),
    uiInertiaPage(isNuxtUiFile),
    uiRequestState(isNuxtUiFile),
    vue({ script: { globalTypeFiles: [sfcGlobalTypesFile] } }),
    sfcGlobalTypesWatcher(
      importDirectories,
      import.meta.dirname,
      sfcGlobalTypesFile,
    ),
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
        imports: autoImportSources(
          normalizePath(resolve(import.meta.dirname, "frontend-module.ts")),
        ),
        dts: "auto-imports.d.ts",
        vueTemplate: true,
      },
    }),
    paintBeforeHydrate(),
    ...vitePlugins(registry.modules, frontendBuilds),
  ],
  worker: { plugins: () => vitePlugins(registry.modules, frontendBuilds) },
  resolve: {
    dedupe: DEDUPED_PACKAGES,
    alias: {
      "#dms/frontend-module": resolve(
        import.meta.dirname,
        "frontend-module.ts",
      ),
      "#dms/server": SERVER_MODULE_ALIAS,
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
  environments: { client: CLIENT_ENVIRONMENT },
});
