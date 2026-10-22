// The frontend modules of an AntelopeJS project, read from the project itself:
// its `antelope.config.ts`, evaluated by AntelopeJS's own config loader, and
// the packages of its modules. Each module declares in its package.json, as
// `dmsFrontend`, a file exporting `frontendModule(config, context)`: the pure
// function its backend passes to `AddFrontendModule`. No backend is asked.

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
const TRAILING_SLASHES = /\/+$/;
const DEFAULT_API_PORT = 80;
const LOOPBACK_HOST = "127.0.0.1";
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

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

type ConfigVars = Record<string, string | number>;

interface ApiServer {
  protocol?: string;
  host?: string;
  port?: number;
}

interface ApiConfig {
  publicBaseUrl?: string;
  servers?: ApiServer[];
}

function apiLocalBaseUrl(server: ApiServer): string {
  const host =
    !server.host || WILDCARD_HOSTS.has(server.host)
      ? LOOPBACK_HOST
      : server.host;
  const protocol = server.protocol ?? "http";
  return `${protocol}://${host}:${server.port ?? DEFAULT_API_PORT}`;
}

/**
 * The config variables of the providers a frontend configuration may read,
 * computed from the provider's configuration as its `provide()` does: core
 * leaves `${@<module>.<VAR>}` to the provider, which never runs here.
 */
const CONFIG_VAR_PROVIDERS: Record<string, (config: unknown) => ConfigVars> = {
  api: (config): ConfigVars => {
    const api = (config ?? {}) as ApiConfig;
    const server = api.servers?.[0];
    if (!server) return {};
    const local = apiLocalBaseUrl(server);
    return {
      API_PORT: server.port ?? DEFAULT_API_PORT,
      API_LOCAL_BASE_URL: local,
      API_PUBLIC_BASE_URL:
        api.publicBaseUrl?.trim().replace(TRAILING_SLASHES, "") || local,
    };
  },
};

function projectConfigVars(config: ProjectConfig): Record<string, ConfigVars> {
  return Object.fromEntries(
    Object.entries(CONFIG_VAR_PROVIDERS)
      .filter(([id]) => config.modules[id])
      .map(([id, provide]) => [id, provide(config.modules[id].config)]),
  );
}

/**
 * The value with each `${@<module>.<VAR>}` replaced by the variable; a value
 * that is only an unknown reference becomes undefined, so defaults apply.
 */
function substituteConfigVars(
  value: unknown,
  vars: Record<string, ConfigVars>,
): unknown {
  if (typeof value === "string") {
    const pure = value.match(PURE_CONFIG_VAR);
    if (pure) return vars[pure[1]]?.[pure[2]];
    return value.replace(CONFIG_VAR_PATTERN, (token, module, name) => {
      const resolved = vars[module]?.[name];
      return resolved === undefined ? token : String(resolved);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => substituteConfigVars(item, vars));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteConfigVars(item, vars),
      ]),
    );
  }
  return value;
}

/**
 * The project's configuration for an environment, as `ajs project start -e`
 * reads it: environment section, module JSON files and `envOverrides` from
 * the current variables.
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
  const vars = projectConfigVars(loaded);
  return {
    cacheFolder: loaded.cacheFolder,
    modules: Object.fromEntries(
      Object.entries(loaded.modules).map(([id, module]) => [
        id,
        { ...module, config: substituteConfigVars(module.config, vars) },
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
      const folder = moduleFolder(
        projectDir,
        config.cacheFolder,
        module.source,
      );
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
