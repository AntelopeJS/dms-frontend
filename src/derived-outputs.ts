// The workspace files derived from the frontend-module sources rather than
// copied from them: the module registry and loader, the type paths, the public
// assets, the locale catalogs and the aggregated shortcuts.
//
// Materialization writes all of them. In development the layer watcher
// rewrites those a change can affect (`DERIVED_OUTPUTS`), from the same
// writers.
//
// Split out of materialize.ts, whose size the linter caps.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { FRONTEND_MODULE_ENTRY, LAYERS_SUBDIR } from "./config";
import { frontendLayerTypePaths, MODULE_LAYERS_DIRNAME } from "./layer-aliases";
import { getLayerSafeName, getLayerWorkspacePath } from "./layers";
import { FrontendModuleOptions, ResolvedLayer } from "./workspace";

import {
  applyContent,
  collectFiles,
  mirrorFiles,
  toPosixPath,
} from "./fs-sync";

export interface FrontendModuleRegistryEntry {
  id: string;
  packageName?: string;
  root: string;
  priority: number;
  entry?: string;
  options: FrontendModuleOptions;
}

export interface FrontendModuleRegistry {
  modules: FrontendModuleRegistryEntry[];
}

const GENERATED_MODULE_ID = /^[A-Za-z0-9_-]+$/;

function validateFrontendModuleRegistry(
  registry: FrontendModuleRegistry,
  workspaceDir: string,
): void {
  const ids = new Set<string>();
  const moduleRoot = `${resolve(workspaceDir, LAYERS_SUBDIR)}${sep}`;
  for (const module of registry.modules) {
    if (!GENERATED_MODULE_ID.test(module.id) || ids.has(module.id))
      throw new Error(`Invalid or duplicate frontend module id: ${module.id}`);
    if (!Number.isFinite(module.priority))
      throw new Error(`Invalid frontend module priority: ${module.id}`);
    if (module.entry !== undefined && module.entry !== FRONTEND_MODULE_ENTRY)
      throw new Error(`Invalid frontend module entry: ${module.id}`);
    if (!resolve(module.root).startsWith(moduleRoot))
      throw new Error(
        `Frontend module root escapes the workspace: ${module.id}`,
      );
    ids.add(module.id);
  }
}

/** Build the deterministic registry consumed by the Vite application. */
export function createFrontendModuleRegistry(
  workspaceDir: string,
  layers: ResolvedLayer[],
): FrontendModuleRegistry {
  const modules = layers.map((layer) => {
    const sourceEntry = join(layer.path, FRONTEND_MODULE_ENTRY);
    const options = layer.options ?? {};
    return {
      id: getLayerSafeName(layer),
      packageName: layer.packageName,
      root: getLayerWorkspacePath(workspaceDir, layer),
      priority: layer.priority ?? 0,
      entry: existsSync(sourceEntry) ? FRONTEND_MODULE_ENTRY : undefined,
      options: layer.configKey ? { [layer.configKey]: options } : options,
    };
  });
  modules.sort(
    (left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id),
  );
  const registry = { modules };
  validateFrontendModuleRegistry(registry, workspaceDir);
  return registry;
}

/**
 * Declare the workspace's module specifiers to TypeScript.
 *
 * The layer aliases come from `frontendLayerTypePaths`, the same helper a
 * module's own test runner calls, so the convention has one definition. The
 * registry is sorted by descending priority and the helper resolves same-name
 * collisions in favour of the last root, hence the reversal: the
 * highest-priority module is the one that keeps the alias.
 */
function writeFrontendTypePaths(
  workspaceDir: string,
  registry: FrontendModuleRegistry,
): boolean {
  const paths: Record<string, string[]> = {
    "#dms/frontend-module": ["./frontend-module.ts"],
    "@frontend/*": ["./frontend-modules/*"],
    ...frontendLayerTypePaths(
      [...registry.modules].reverse().map((module) => module.root),
      { relativeTo: workspaceDir },
    ),
  };
  const config = { compilerOptions: { paths } };
  return applyContent(
    `${JSON.stringify(config, null, 2)}\n`,
    join(workspaceDir, "frontend-paths.generated.json"),
  );
}

function writeFrontendModuleLoader(
  workspaceDir: string,
  registry: FrontendModuleRegistry,
): boolean {
  const modules = registry.modules.filter((module) => module.entry);
  const imports = modules
    .map(
      (module, index) =>
        `import module${index} from "@frontend/${module.id}/${module.entry}";`,
    )
    .join("\n");
  const registrations = modules
    .map(
      (module, index) =>
        `{ module: module${index}, options: { public: ${JSON.stringify(module.options)} } }`,
    )
    .join(", ");
  const content = `${imports}\n\nimport type { DmsFrontendModuleRegistration } from "./frontend-module";\n\nexport const frontendModules: DmsFrontendModuleRegistration[] = [${registrations}];\n`;
  return applyContent(
    content,
    join(workspaceDir, "frontend-modules.generated.ts"),
  );
}

/**
 * The registry itself, which the generated configs and server read, and the
 * loader through which the application imports each module's entry.
 */
function writeModuleRegistry(
  workspaceDir: string,
  registry: FrontendModuleRegistry,
): boolean {
  const wroteRegistry = applyContent(
    `${JSON.stringify(registry, null, 2)}\n`,
    join(workspaceDir, "generated-frontend-modules.json"),
  );
  return writeFrontendModuleLoader(workspaceDir, registry) || wroteRegistry;
}

interface DiscoveredAsset {
  moduleId: string;
  relativePath: string;
}

interface AssetRoot {
  absolutePath: string;
  relativePrefix: string;
}

function moduleAssetRoots(moduleRoot: string): AssetRoot[] {
  const layersRoot = join(moduleRoot, "layers");
  if (!existsSync(layersRoot)) {
    return [{ absolutePath: moduleRoot, relativePrefix: "" }];
  }
  return readdirSync(layersRoot).map((name) => ({
    absolutePath: join(layersRoot, name),
    relativePrefix: `layers/${name}/`,
  }));
}

/** Where each asset root keeps the files served as they are. */
const PUBLIC_DIRECTORY = "public";

/**
 * Merge every module's public files into the workspace's `public/`, which the
 * dev server serves and the build copies. Modules go in increasing priority,
 * so the highest-priority one keeps a contested path, as does the last of a
 * module's layers.
 */
function writePublicAssets(
  workspaceDir: string,
  registry: FrontendModuleRegistry,
): boolean {
  const files = new Map<string, string>();
  for (const module of [...registry.modules].reverse()) {
    for (const root of moduleAssetRoots(module.root)) {
      const source = join(root.absolutePath, PUBLIC_DIRECTORY);
      for (const file of collectFiles(source)) {
        files.set(file, join(source, file));
      }
    }
  }
  return mirrorFiles(files, join(workspaceDir, PUBLIC_DIRECTORY));
}

function discoverAssets(
  registry: FrontendModuleRegistry,
  directory: string,
  extensions: string[],
): DiscoveredAsset[] {
  return registry.modules.flatMap((module) => {
    return moduleAssetRoots(module.root).flatMap((assetRoot) => {
      const root = join(assetRoot.absolutePath, directory);
      return collectFiles(root)
        .filter((file) =>
          extensions.some((extension) => file.endsWith(extension)),
        )
        .sort()
        .map((relativePath) => ({
          moduleId: module.id,
          relativePath: `${assetRoot.relativePrefix}${toPosixPath(join(directory, relativePath))}`,
        }));
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeLocaleMessages(
  source: Record<string, unknown>,
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...source };
  for (const [key, value] of Object.entries(existing)) {
    const sourceValue = merged[key];
    merged[key] =
      isRecord(sourceValue) && isRecord(value)
        ? mergeLocaleMessages(sourceValue, value)
        : value;
  }
  return merged;
}

/** Where each asset root keeps its locale files, one JSON file per locale. */
const LOCALE_DIRECTORY = "i18n/locales";

/**
 * A locale file that does not parse: in development an editor can save a
 * catalog half-written. Carries the file, which the dev watcher shows as the
 * source the user edits.
 */
export class InvalidLocaleFileError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Invalid locale file ${path}: ${reason}`);
    this.name = "InvalidLocaleFileError";
  }
}

function readLocaleFile(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidLocaleFileError(path, reason);
  }
}

function readLocaleMessages(
  assets: DiscoveredAsset[],
  registry: FrontendModuleRegistry,
): Record<string, Record<string, unknown>> {
  const roots = new Map(
    registry.modules.map((module) => [module.id, module.root]),
  );
  const messages: Record<string, Record<string, unknown>> = {};
  for (const asset of assets) {
    const locale = asset.relativePath.match(
      /(?:^|[/-])([a-z]{2})-[A-Z]{2}\.json$/,
    )?.[1];
    const root = roots.get(asset.moduleId);
    if (!locale || !root) continue;
    const value = readLocaleFile(join(root, asset.relativePath));
    messages[locale] = mergeLocaleMessages(value, messages[locale] ?? {});
  }
  return messages;
}

/**
 * Whether `relativePath`, relative to a module root, names its `layers/`
 * directory or one of the layers in it, whose creation or removal adds or
 * removes an asset root with everything in it.
 */
function isLayerDirectory(relativePath: string): boolean {
  const segments = toPosixPath(relativePath).split("/");
  return segments[0] === MODULE_LAYERS_DIRNAME && segments.length <= 2;
}

/**
 * Whether a change at `relativePath`, relative to a module root, can change
 * what its asset roots hold under `directory`: anything under it, or a
 * directory on the way to it, whose creation or removal brings or takes a
 * whole set of files at once.
 */
function affectsAssetDirectory(
  directory: string,
  relativePath: string,
): boolean {
  if (isLayerDirectory(relativePath)) return true;
  const segments = toPosixPath(relativePath).split("/");
  const withinRoot =
    segments[0] === MODULE_LAYERS_DIRNAME ? segments.slice(2) : segments;
  return directory
    .split("/")
    .every(
      (segment, index) =>
        index >= withinRoot.length || withinRoot[index] === segment,
    );
}

/** Whether a change at `relativePath` can change the generated catalogs. */
export function affectsLocaleMessages(relativePath: string): boolean {
  return affectsAssetDirectory(LOCALE_DIRECTORY, relativePath);
}

/**
 * The module the application imports its catalogs from: English bundled as
 * the fallback, every other locale loaded on first use.
 *
 * In development the layer watcher regenerates the catalogs while the app
 * runs, and this module accepts its own hot updates. The application keeps
 * the exports of the instance it imported first, so every instance shares one
 * state through `import.meta.hot.data` (the catalogs loaded so far and the
 * i18n instances fed from them), and each new one refreshes it from the
 * catalogs it imports. Accepting itself rather than its imports matters to
 * the server renderer: Vite stops invalidating importers at a module that
 * accepts the changed import, which would leave the next server render on the
 * old catalogs. An added or removed locale changes what the application was
 * set up with, so that update falls back to a full reload.
 */
function localeModuleSource(supportedLocales: string[]): string {
  const loaders = supportedLocales
    .filter((locale) => locale !== "en")
    .map(
      (locale) =>
        `  ${JSON.stringify(locale)}: () => import(${JSON.stringify(`./locales.generated/${locale}`)}),`,
    );
  return `import defaultMessages from "./locales.generated/en";

type LocaleMessages = Record<string, unknown>;
type LocaleLoader = () => Promise<{ default: LocaleMessages }>;
interface LocaleMessagesTarget {
  setLocaleMessage(locale: string, messages: LocaleMessages): void;
}
interface LocaleState {
  messages: Record<string, LocaleMessages>;
  targets: Set<LocaleMessagesTarget>;
  version: number;
}

export const supportedLocales = ${JSON.stringify(supportedLocales)};
const localeLoaders: Record<string, LocaleLoader> = {
  "en": async () => ({ default: defaultMessages }),
${loaders.join("\n")}
};
const shared: LocaleState | undefined = import.meta.hot?.data.state;
const state: LocaleState = shared ?? {
  messages: { en: defaultMessages },
  targets: new Set(),
  version: 0,
};
export const localeMessages = state.messages;

async function readLocaleMessages(locale: string): Promise<LocaleMessages> {
  return (await localeLoaders[locale]()).default;
}

export async function loadLocaleMessages(locale: string): Promise<LocaleMessages> {
  const normalized = locale.slice(0, 2);
  if (!localeLoaders[normalized]) return localeMessages.en;
  localeMessages[normalized] ??= await readLocaleMessages(normalized);
  return localeMessages[normalized];
}

/** Development only: applies every regenerated catalog to \`target\`. */
export function syncLocaleMessages(target: LocaleMessagesTarget): void {
  if (import.meta.hot) state.targets.add(target);
}

async function refreshLocaleMessages(): Promise<void> {
  const version = ++state.version;
  const locales = Object.keys(localeMessages).filter(
    (locale) => locale in localeLoaders,
  );
  const catalogs = await Promise.all(locales.map(readLocaleMessages));
  if (version !== state.version) return;
  locales.forEach((locale, index) => {
    localeMessages[locale] = catalogs[index];
    for (const target of state.targets)
      target.setLocaleMessage(locale, catalogs[index]);
  });
}

if (import.meta.hot) {
  import.meta.hot.data.state = state;
  if (shared) void refreshLocaleMessages();
  import.meta.hot.accept((next) => {
    if (next?.supportedLocales.join() !== supportedLocales.join())
      import.meta.hot?.invalidate("the list of locales changed");
  });
}
`;
}

/**
 * Merge every module's `i18n/locales/*.json` into one catalog per locale, in
 * manifest-priority order, and write what the app, the server renderer and
 * the email bundle import: `locales.generated/<locale>.{json,ts}`,
 * `locales.generated.ts` and `email-locales.generated.json`.
 *
 * Materialization writes them once; in development the layer watcher writes
 * them again whenever a locale file changes. Every catalog is read before
 * anything is written, so a file saved half-written keeps the previous
 * catalogs. A file is only rewritten when its content changes, a catalog
 * before the module that imports it, and stale catalogs go last: Vite never
 * reloads for nothing, nor finds a catalog missing.
 */
export function writeLocaleMessages(
  workspaceDir: string,
  registry: FrontendModuleRegistry,
): boolean {
  const locales = discoverAssets(registry, LOCALE_DIRECTORY, [".json"]);
  const messages = readLocaleMessages(locales, registry);
  const outputDir = join(workspaceDir, "locales.generated");
  const outputs = new Set<string>();
  let changed = false;
  const apply = (content: string, path: string): void => {
    changed = applyContent(content, path) || changed;
  };
  mkdirSync(outputDir, { recursive: true });
  for (const [locale, value] of Object.entries(messages)) {
    const catalog = JSON.stringify(value);
    apply(catalog, join(outputDir, `${locale}.json`));
    apply(
      `const messages = ${catalog};\nexport default messages;\n`,
      join(outputDir, `${locale}.ts`),
    );
    outputs.add(`${locale}.json`).add(`${locale}.ts`);
  }
  const supportedLocales = Object.keys(messages);
  apply(
    JSON.stringify(supportedLocales),
    join(workspaceDir, "email-locales.generated.json"),
  );
  apply(
    localeModuleSource(supportedLocales),
    join(workspaceDir, "locales.generated.ts"),
  );
  for (const name of readdirSync(outputDir)) {
    if (outputs.has(name)) continue;
    rmSync(join(outputDir, name), { recursive: true, force: true });
    changed = true;
  }
  return changed;
}

/** Where each asset root keeps its shortcut registry. */
const SHORTCUTS_DIRECTORY = "app/config";

function writeShortcutExports(
  workspaceDir: string,
  registry: FrontendModuleRegistry,
): boolean {
  const registries = discoverAssets(registry, SHORTCUTS_DIRECTORY, [
    "shortcuts-registry.ts",
    "shortcuts-registry.js",
  ]);
  const imports = registries.map(
    (asset, index) =>
      `import registry${index} from "@frontend/${asset.moduleId}/${asset.relativePath}";`,
  );
  const spreads = registries.map((_, index) => `...registry${index}`);
  const content = `${imports.join("\n")}\nconst aggregatedShortcuts = [${spreads.join(", ")}];\nexport { aggregatedShortcuts };\nexport default aggregatedShortcuts;\n`;
  return applyContent(
    content,
    join(workspaceDir, "shortcuts-aggregated.generated.ts"),
  );
}

/**
 * One file, or one set of files, of the workspace derived from the module
 * sources. Materialization writes every one, and the dev layer watcher
 * rewrites those whose sources a change touched.
 */
export interface DerivedOutput {
  /** How the watcher's warnings name the output. */
  name: string;
  /** Whether a change at a path relative to a module root can change it. */
  affects(relativePath: string): boolean;
  /**
   * Writes the output, only the files whose content changes, and tells
   * whether any did.
   */
  write(workspaceDir: string, registry: FrontendModuleRegistry): boolean;
  /**
   * For an output the running dev server cannot apply: what the watcher
   * tells the user to do when a change rewrites it.
   */
  restartHint?: string;
}

/**
 * Every derived output, in the order they are written.
 *
 * The dev server serves `public/` from disk, and Vite follows the generated
 * modules through its own watcher. The type paths are the exception: they list
 * the layer directories, from which the generated Vite configs also derive the
 * `#<layer>` aliases and the auto-imported directories, once, at startup. An
 * added or removed layer is applied by a restart only, and the watcher says so.
 */
export const DERIVED_OUTPUTS: readonly DerivedOutput[] = [
  {
    name: "module registry",
    affects: (path) => toPosixPath(path) === FRONTEND_MODULE_ENTRY,
    write: writeModuleRegistry,
  },
  {
    name: "type paths",
    affects: isLayerDirectory,
    write: writeFrontendTypePaths,
    restartHint:
      "Restart ajs dms dev to apply it (Vite reads the '#<layer>' aliases and the auto-imported directories at startup)",
  },
  {
    name: "locale catalogs",
    affects: affectsLocaleMessages,
    write: writeLocaleMessages,
  },
  {
    name: "aggregated shortcuts",
    affects: (path) => affectsAssetDirectory(SHORTCUTS_DIRECTORY, path),
    write: writeShortcutExports,
  },
  {
    name: "public assets",
    affects: (path) => affectsAssetDirectory(PUBLIC_DIRECTORY, path),
    write: writePublicAssets,
  },
];
