// The frontend modules of an AntelopeJS project, read from the project itself:
// its `antelope.config.ts`, evaluated by AntelopeJS's own config loader, and
// the packages of its modules. Each module declares in its package.json, as
// `dmsFrontend`, a file exporting `frontendModule(config, context)`: the pure
// function its backend passes to `AddFrontendModule`. No backend is asked.
// The `${@<module>.<VAR>}` references resolve the same way: each provider
// declares, as `antelopeJs.configVarsFile`, a file exporting the pure
// `configVars(config)` its own `provide` publishes from.

import { existsSync, readFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CliError, getProcessUi } from "@antelopejs/core/cli";
import { readLayerPackage } from "./layers";
import { emptiedOptions } from "./private-values";
import type {
  BackendProxyDeclaration,
  FrontendModuleOptions,
  PublicEndpointDeclaration,
  ResolvedLayer,
} from "./workspace";

/** The package.json field naming a module's frontend registration file. */
export const FRONTEND_DECLARATION_FIELD = "dmsFrontend";
const FRONTEND_SOURCE_DIR = "frontend-vue";
const RENDERER = { name: "vue", version: "3" };
const CONFIG_VAR_PATTERN = /\$\{@([^.}]+)\.([^}]+)\}/g;
const PURE_CONFIG_VAR = /^\$\{@([^.}]+)\.([^}]+)\}$/;
/** AntelopeJS's file that replaces the `antelopeJs` block of package.json. */
const MODULE_MANIFEST_FILE = "antelope.module.json";

/** What a module's `frontendModule` returns: `AddFrontendModuleOptions`. */
export interface FrontendRegistration {
  name: string;
  sourcePath: string;
  renderer: { name: string; version: string };
  priority?: number;
  configKey?: string;
  options?: FrontendModuleOptions;
  privateOptions?: FrontendModuleOptions;
  authEstablishEndpoints?: string[];
  publicEndpoints?: PublicEndpointDeclaration[];
  backendProxies?: BackendProxyDeclaration[];
}

/** What a module's `frontendModule` is called with besides its config. */
export interface FrontendModuleContext {
  dev: boolean;
}

type FrontendModuleFunction = (
  config: unknown,
  context: FrontendModuleContext,
) => FrontendRegistration | undefined;

interface ModuleSource {
  type: string;
  path?: string;
  package?: string;
}

interface ProjectModule {
  source: ModuleSource;
  config: unknown;
  /** Where the module's package is installed, if it is. */
  folder?: string;
}

interface ProjectConfig {
  cacheFolder: string;
  modules: Record<string, ProjectModule>;
}

/** A project's frontend module: its layer and the version it ships in. */
export interface ProjectFrontendModule {
  layer: ResolvedLayer;
  version?: string;
}

export interface ProjectModulesOptions {
  projectDir: string;
  /** The AntelopeJS environment (`-e`), whose overrides apply. */
  environment: string;
  dev?: boolean;
}

/** AntelopeJS's file system interface, on Node's own. */
const NODE_FILE_SYSTEM = {
  readFile: (path: string) => fsPromises.readFile(path),
  readFileString: (path: string, encoding: BufferEncoding = "utf-8") =>
    fsPromises.readFile(path, encoding),
  writeFile: (path: string, data: Buffer | string) =>
    fsPromises.writeFile(path, data),
  readdir: (path: string) => fsPromises.readdir(path),
  stat: (path: string) => fsPromises.stat(path),
  mkdir: async (path: string, options?: { recursive?: boolean }) => {
    await fsPromises.mkdir(path, options);
  },
  rm: (path: string, options?: { recursive?: boolean; force?: boolean }) =>
    fsPromises.rm(path, options),
  exists: async (path: string) => existsSync(path),
  access: (path: string) => fsPromises.access(path),
  copyFile: (src: string, dest: string) => fsPromises.copyFile(src, dest),
  rename: (oldPath: string, newPath: string) =>
    fsPromises.rename(oldPath, newPath),
};

/** What a provider publishes, as AntelopeJS types it. */
type ConfigVars = Record<string, string | number | boolean>;

type ConfigVarsFunction = (config: unknown) => ConfigVars;

/** The `antelopeJs` fields of a provider the config variables come from. */
interface ConfigVarsManifest {
  configVars?: unknown;
  configVarsFile?: unknown;
}

interface ConfigVarsProvider {
  declared: string[];
  configVars: ConfigVarsFunction;
}

type ConfigVarLookup = (
  module: string,
  name: string,
) => ConfigVars[string] | undefined;

/** A module's `antelopeJs` block, from antelope.module.json when it has one, as AntelopeJS reads it. */
function readAntelopeManifest(folder: string): ConfigVarsManifest | undefined {
  const dedicated = join(folder, MODULE_MANIFEST_FILE);
  if (existsSync(dedicated))
    return JSON.parse(readFileSync(dedicated, "utf-8")) as ConfigVarsManifest;
  return readLayerPackage(folder)?.antelopeJs as ConfigVarsManifest | undefined;
}

function warnUndeclaredConfigVars(id: string): void {
  getProcessUi().message(
    "warn",
    `${id} declares no antelopeJs.configVarsFile in its package.json: the \${@${id}.<VAR>} references are left unresolved`,
    { detail: `Upgrade ${id} to a version that declares it` },
  );
}

function configVarsProvider(
  id: string,
  folder: string,
): ConfigVarsProvider | undefined {
  const manifest = readAntelopeManifest(folder);
  const file = manifest?.configVarsFile;
  if (typeof file !== "string") {
    warnUndeclaredConfigVars(id);
    return undefined;
  }
  const { configVars } = require(join(folder, file)) as {
    configVars?: ConfigVarsFunction;
  };
  if (typeof configVars !== "function") {
    throw new CliError({
      title: `${id}: ${file} exports no configVars function`,
      fixes: [`Export configVars(config) from ${file}`],
    });
  }
  const declared = Array.isArray(manifest?.configVars)
    ? manifest.configVars.filter((name) => typeof name === "string")
    : [];
  return { declared, configVars };
}

function computeConfigVars(
  id: string,
  provider: ConfigVarsProvider,
  config: unknown,
): ConfigVars {
  let computed: ConfigVars;
  try {
    computed = provider.configVars(config) ?? {};
  } catch (error) {
    throw new CliError(
      {
        title: `${id}: could not compute its config variables`,
        reason: error instanceof Error ? error.message : String(error),
      },
      { cause: error },
    );
  }
  // Only the declared ones, as AntelopeJS publishes them.
  return Object.fromEntries(
    provider.declared
      .filter((name) => name in computed)
      .map((name) => [name, computed[name]]),
  );
}

/**
 * Looks up `${@<module>.<VAR>}` in the variables its provider computes from
 * its own configuration, itself resolved first. A provider is only read once
 * referenced; one that is not installed, declares no `configVarsFile` or
 * takes part in a cycle leaves its references unresolved.
 */
function configVarLookup(
  modules: Record<string, ProjectModule>,
): ConfigVarLookup {
  const published = new Map<string, ConfigVars | undefined>();
  const lookup: ConfigVarLookup = (id, name) => {
    if (!published.has(id)) {
      published.set(id, undefined);
      const module = modules[id];
      const provider = module?.folder && configVarsProvider(id, module.folder);
      if (provider)
        published.set(
          id,
          computeConfigVars(
            id,
            provider,
            substituteConfigVars(module.config, lookup),
          ),
        );
    }
    return published.get(id)?.[name];
  };
  return lookup;
}

/**
 * The value with each `${@<module>.<VAR>}` replaced by the variable; a value
 * that is only an unknown reference becomes undefined, so defaults apply.
 */
function substituteConfigVars(
  value: unknown,
  lookup: ConfigVarLookup,
): unknown {
  if (typeof value === "string") {
    const pure = value.match(PURE_CONFIG_VAR);
    if (pure) return lookup(pure[1], pure[2]);
    return value.replace(CONFIG_VAR_PATTERN, (token, module, name) => {
      const resolved = lookup(module, name);
      return resolved === undefined ? token : String(resolved);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => substituteConfigVars(item, lookup));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteConfigVars(item, lookup),
      ]),
    );
  }
  return value;
}

/**
 * The project's configuration for an environment, as `ajs project start -e`
 * reads it: environment section, module JSON files and `envOverrides` from
 * the current variables. Each module comes with its installed folder.
 */
export async function loadProjectConfig(
  projectDir: string,
  environment: string,
): Promise<ProjectConfig> {
  const { ConfigLoader } = await import("@antelopejs/core");
  type FileSystem = ConstructorParameters<typeof ConfigLoader>[0];
  const loader = new ConfigLoader(NODE_FILE_SYSTEM as FileSystem);
  let loaded: ProjectConfig;
  try {
    loaded = (await loader.load(projectDir, environment)) as ProjectConfig;
  } catch (error) {
    throw new CliError(
      {
        title: `Could not evaluate the project's configuration in ${projectDir}`,
        reason: error instanceof Error ? error.message : String(error),
        fixes: ["Run from the project root, or pass --project <dir>"],
      },
      { cause: error },
    );
  }
  const located: Record<string, ProjectModule> = Object.fromEntries(
    Object.entries(loaded.modules).map(([id, module]) => [
      id,
      {
        ...module,
        folder: moduleFolder(projectDir, loaded.cacheFolder, module.source),
      },
    ]),
  );
  const lookup = configVarLookup(located);
  return {
    cacheFolder: loaded.cacheFolder,
    modules: Object.fromEntries(
      Object.entries(located).map(([id, module]) => [
        id,
        { ...module, config: substituteConfigVars(module.config, lookup) },
      ]),
    ),
  };
}

/**
 * Where a module's package is: a local source's path, or a package installed
 * in the project's node_modules, else in AntelopeJS's module cache.
 */
function moduleFolder(
  projectDir: string,
  cacheFolder: string,
  source: ModuleSource,
): string | undefined {
  const candidates =
    source.type === "local" && source.path
      ? [resolve(projectDir, source.path)]
      : source.package
        ? [
            join(projectDir, "node_modules", source.package),
            resolve(projectDir, cacheFolder, source.package),
          ]
        : [];
  return candidates.find((folder) => existsSync(join(folder, "package.json")));
}

/**
 * The version of the package shipping a frontend module, the one above its
 * source directory, as the backend reads it.
 */
export function readShippingVersion(sourcePath: string): string | undefined {
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(sourcePath), "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

function toLayer(registration: FrontendRegistration): ResolvedLayer {
  const name = readLayerPackage(registration.sourcePath)?.name;
  return {
    path: registration.sourcePath,
    name: registration.name,
    sourcePath: registration.sourcePath,
    packageName: typeof name === "string" ? name : undefined,
    priority: registration.priority ?? 0,
    configKey: registration.configKey,
    options: registration.options ?? {},
    // A build is deployed: whatever a module returns, no secret is written.
    privateOptions:
      registration.privateOptions &&
      emptiedOptions(registration.privateOptions),
    authEstablishEndpoints: registration.authEstablishEndpoints ?? [],
    publicEndpoints: registration.publicEndpoints ?? [],
    backendProxies: registration.backendProxies ?? [],
  };
}

function warnMissingModule(id: string): void {
  getProcessUi().message(
    "warn",
    `${id} is not installed in the project: its pages, if it has any, are left out`,
    { detail: "Install the project's modules first: ajs project build" },
  );
}

function warnUndeclaredFrontend(id: string, folder: string): void {
  if (!existsSync(join(folder, FRONTEND_SOURCE_DIR))) return;
  getProcessUi().message(
    "warn",
    `${id} ships ${FRONTEND_SOURCE_DIR}/ but declares no ${FRONTEND_DECLARATION_FIELD} in its package.json: its pages are left out`,
  );
}

function registrationOf(
  id: string,
  folder: string,
  config: unknown,
  context: FrontendModuleContext,
): FrontendRegistration | undefined {
  const declaration = readLayerPackage(folder)?.[FRONTEND_DECLARATION_FIELD];
  if (typeof declaration !== "string") {
    warnUndeclaredFrontend(id, folder);
    return undefined;
  }
  const { frontendModule } = require(join(folder, declaration)) as {
    frontendModule?: FrontendModuleFunction;
  };
  if (typeof frontendModule !== "function") {
    throw new CliError({
      title: `${id}: ${declaration} exports no frontendModule function`,
      fixes: [`Export frontendModule(config, context) from ${declaration}`],
    });
  }
  return frontendModule(config, context);
}

function isServedRenderer(registration: FrontendRegistration): boolean {
  return (
    registration.renderer.name === RENDERER.name &&
    registration.renderer.version === RENDERER.version
  );
}

/** One registration per name, the highest priority winning, as the backend keeps them. */
function keepHighestPriority(
  registrations: FrontendRegistration[],
): FrontendRegistration[] {
  const byName = new Map<string, FrontendRegistration>();
  for (const registration of registrations) {
    const kept = byName.get(registration.name);
    if (!kept || (kept.priority ?? 0) <= (registration.priority ?? 0))
      byName.set(registration.name, registration);
  }
  return [...byName.values()];
}

/**
 * The project's frontend modules, highest priority first, with the options
 * their `frontendModule` computes from the project's configuration.
 */
export async function readProjectFrontendModules(
  options: ProjectModulesOptions,
): Promise<ProjectFrontendModule[]> {
  const projectDir = resolve(options.projectDir);
  const config = await loadProjectConfig(projectDir, options.environment);
  const context: FrontendModuleContext = { dev: !!options.dev };
  const registrations = Object.entries(config.modules).flatMap(
    ([id, module]) => {
      const folder = module.folder;
      if (!folder) {
        warnMissingModule(id);
        return [];
      }
      const registration = registrationOf(id, folder, module.config, context);
      return registration && isServedRenderer(registration)
        ? [registration]
        : [];
    },
  );
  return keepHighestPriority(registrations)
    .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
    .map((registration) => ({
      layer: toLayer(registration),
      version: readShippingVersion(registration.sourcePath),
    }));
}
