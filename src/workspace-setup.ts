import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError, getProcessTasks, isVerboseRun } from "@antelopejs/core/cli";
import {
  createPathMapper,
  describeChildFailure,
  InstallProgress,
  type PathMapper,
} from "./child-output";
import { runWorkspacePnpm } from "./child-command";
import { assertLayerPathsServed, buildLayersFromPaths } from "./layers";
import {
  assertCachedLayerPathsExist,
  type ManifestCacheUse,
  type ResolvedManifest,
  resolveManifest,
} from "./manifest";
import {
  readProjectModulesFresh,
  warnModuleDrift,
  withBackendValues,
} from "./dev-modules";
import {
  type ProjectFrontendModule,
  type ProjectModulesOptions,
  readProjectFrontendModules,
} from "./project-modules";
import {
  collectManifestSecrets,
  type ManifestSecrets,
} from "./manifest-secrets";
import { assertLayersSupportRenderer } from "./renderer-range";
import {
  writeFrontendModuleRegistry,
  copyStaticTemplates,
  materializeLayers,
  writeDmsMainCss,
  writeWorkspacePackageJson,
} from "./materialize";
import {
  ensureExplicitWorkspace,
  ensureWorkspace,
  ResolvedLayer,
  writeWorkspaceMeta,
} from "./workspace";
import { CancelledError } from "./cancellation";
import { endInterruptedTask } from "./output";
import { canonicalizeBackendUrl, DEPS_HASH_FILE } from "./config";
import { InvalidLocaleFileError } from "./locale-files";

const WORKSPACE_PNPM_CONFIG = "pnpm-workspace.yaml";
const WORKSPACE_PATCHES_DIR = "patches";

/**
 * Workspace files besides the package manifests that change what `pnpm
 * install` produces: the pnpm workspace config, which lists the dependency
 * patches, and the patches themselves. A workspace installed before a patch
 * was added or changed has to install again to pick it up.
 */
function workspaceInstallInputs(workspaceDir: string): string[] {
  const patchesDir = join(workspaceDir, WORKSPACE_PATCHES_DIR);
  const patches = existsSync(patchesDir)
    ? readdirSync(patchesDir)
        .sort()
        .map((name) => join(patchesDir, name))
    : [];
  return [join(workspaceDir, WORKSPACE_PNPM_CONFIG), ...patches];
}

export function computeDepsHash(
  layerPaths: string[],
  workspacePackage?: string,
  installInputs: readonly string[] = [],
): string {
  const hash = createHash("sha256");
  if (workspacePackage && existsSync(workspacePackage))
    hash.update(readFileSync(workspacePackage));
  for (const input of installInputs) {
    if (existsSync(input)) hash.update(readFileSync(input));
  }
  for (const layerPath of [...layerPaths].sort()) {
    const pkgPath = join(layerPath, "package.json");
    if (existsSync(pkgPath)) {
      hash.update(readFileSync(pkgPath, "utf-8"));
    }
  }
  return hash.digest("hex");
}

/**
 * Check if dependencies need to be installed.
 * Returns true if install is needed.
 */
export function needsInstall(
  workspaceDir: string,
  layerPaths: string[],
  force: boolean,
): boolean {
  if (force) return true;

  const hashFile = join(workspaceDir, DEPS_HASH_FILE);
  if (!existsSync(hashFile)) return true;
  if (!existsSync(join(workspaceDir, "node_modules"))) return true;

  const currentHash = computeDepsHash(
    layerPaths,
    join(workspaceDir, "package.json"),
    workspaceInstallInputs(workspaceDir),
  );
  const savedHash = readFileSync(hashFile, "utf-8").trim();
  return currentHash !== savedHash;
}

/**
 * Save the current deps hash after a successful install
 */
export function saveDepsHash(workspaceDir: string, layerPaths: string[]): void {
  const hash = computeDepsHash(
    layerPaths,
    join(workspaceDir, "package.json"),
    workspaceInstallInputs(workspaceDir),
  );
  writeFileSync(join(workspaceDir, DEPS_HASH_FILE), hash);
}

/** Append-only: the CLI reads pnpm's output line by line. */
const PNPM_INSTALL_ARGS = ["install", "--reporter=append-only"];

/**
 * Run pnpm install in the workspace directory, as one task whose label follows
 * pnpm's progress. Its output is kept and replayed on failure, or streamed
 * behind a gutter in a verbose run. `extraArgs` follow pnpm's own, e.g.
 * `--ignore-scripts`.
 *
 * Disables npm's update notifier: a DMS user has no reason to upgrade the pnpm
 * that installs a generated workspace.
 */
export async function installDeps(
  workspaceDir: string,
  mapLine?: PathMapper,
  extraArgs: string[] = [],
): Promise<void> {
  const progress = new InstallProgress();
  const task = getProcessTasks().start(progress.label);
  try {
    const { code, lines } = await runWorkspacePnpm(
      [...PNPM_INSTALL_ARGS, ...extraArgs],
      {
        name: "pnpm",
        cwd: workspaceDir,
        env: { ...process.env, npm_config_update_notifier: "false" },
        mapLine,
        onLine: (line) => {
          if (progress.read(line)) task.update(progress.label);
        },
      },
    );
    if (code !== 0) {
      throw new CliError(
        describeChildFailure({
          title: "Dependency install failed",
          command: "pnpm install",
          code,
          lines,
          isVerbose: isVerboseRun(),
        }),
      );
    }
    task.succeed(progress.doneLabel);
  } catch (error) {
    endInterruptedTask(
      task,
      error instanceof CancelledError ? error : undefined,
      "Dependency install stopped",
    );
    throw error;
  }
}

export interface SetupWorkspaceOptions {
  force: boolean;
  /**
   * "build" reads the project itself; "dev" reads the project too when
   * `project` is set, completed by the backend's manifest, and the manifest
   * alone otherwise (`prepare`)
   */
  mode: "dev" | "build";
  /** The backend whose manifest a dev workspace follows */
  backendUrl?: string;
  /** Skip the backend fetch and reuse the cached manifest */
  offline?: boolean;
  /** Frontend URL forwarded to the backend on the manifest fetch (dev) */
  clientUrl?: string;
  /**
   * Identity key for the workspace directory. Defaults to the canonical
   * backend URL; autodiscovery mode passes `projectWorkspaceKey(...)` so
   * the workspace survives backend port changes between runs.
   */
  workspaceKey?: string;
  /** Credential presented on the backend's layer endpoints */
  bootstrapSecret?: string;
  /**
   * Directory to set the workspace up in, instead of the one keyed on the
   * backend under the loader home: a build that ships with the project.
   */
  workspaceDir?: string;
  /** The project the modules are read from: always in build, optional in dev. */
  project?: ProjectModulesOptions;
  /** Called before `pnpm install` starts, e.g. to end the task that set the workspace up */
  beforeInstall?: () => Promise<void>;
  /** False writes the workspace and leaves its dependencies as they are. */
  install?: boolean;
}

export interface SetupWorkspaceResult {
  workspaceDir: string;
  layers: ResolvedLayer[];
  /** True when the manifest was replayed from cache (backend not contacted or unreachable) */
  manifestFromCache: boolean;
  /** ISO timestamp of the cached manifest, when `manifestFromCache` is true */
  manifestFetchedAt?: string;
  /** Server secrets the backend published in the manifest */
  manifestSecrets: ManifestSecrets;
}

interface WorkspaceSource {
  fromCache: boolean;
  fetchedAt?: string;
  layers: ResolvedLayer[];
  secrets: ManifestSecrets;
}

/** The project's modules, from its configuration: no backend is asked. */
async function projectLayers(
  project: ProjectModulesOptions,
): Promise<WorkspaceSource> {
  const modules: ProjectFrontendModule[] =
    await readProjectFrontendModules(project);
  return {
    fromCache: false,
    layers: modules.map((module) => module.layer),
    secrets: { published: {}, conflicts: [] },
  };
}

/** The manifest a development backend serves, or the one cached from it. */
function servedManifest(
  opts: SetupWorkspaceOptions,
  backendUrl: string,
  workspaceDir: string,
): Promise<ResolvedManifest> {
  const { offline, clientUrl, bootstrapSecret } = opts;
  const cacheUse: ManifestCacheUse = offline ? "offline" : "fallback";
  return resolveManifest(workspaceDir, backendUrl, cacheUse, {
    clientUrl,
    bootstrapSecret,
  });
}

/**
 * The project's modules, read with `dev: true`, with the secrets and the
 * development origins of the backend's manifest. The manifest is still
 * fetched, and cached: it hands the backend the dev server's address, and
 * `dev` follows its module set to rebuild when the module store changes it.
 */
async function projectLayersInDev(
  opts: SetupWorkspaceOptions,
  project: ProjectModulesOptions,
  backendUrl: string,
  workspaceDir: string,
): Promise<WorkspaceSource> {
  const { manifest, fromCache, fetchedAt } = await servedManifest(
    opts,
    backendUrl,
    workspaceDir,
  );
  const modules = await readProjectModulesFresh({ ...project, dev: true });
  const layers = withBackendValues(modules, manifest);
  warnModuleDrift(layers, manifest);
  return {
    fromCache,
    fetchedAt,
    layers,
    secrets: collectManifestSecrets(
      layers.map((layer) => ({
        name: layer.name ?? "",
        priority: layer.priority ?? 0,
        privateOptions: layer.privateOptions,
      })),
    ),
  };
}

/**
 * The manifest and source paths a development backend serves, or the ones
 * cached from it.
 */
async function servedLayers(
  opts: SetupWorkspaceOptions,
  backendUrl: string,
  workspaceDir: string,
): Promise<WorkspaceSource> {
  const { bootstrapSecret } = opts;
  const { manifest, fromCache, fetchedAt } = await servedManifest(
    opts,
    backendUrl,
    workspaceDir,
  );
  assertLayerPathsServed(manifest.modules, backendUrl, {
    bootstrapSecret,
    cache: fromCache ? { fetchedAt } : undefined,
  });
  if (fromCache) {
    assertCachedLayerPathsExist(manifest.modules, fetchedAt);
  }
  return {
    fromCache,
    fetchedAt,
    layers: buildLayersFromPaths(manifest.modules),
    secrets: collectManifestSecrets(manifest.modules),
  };
}

function workspaceDirFor(opts: SetupWorkspaceOptions): string {
  if (opts.workspaceDir) return ensureExplicitWorkspace(opts.workspaceDir);
  const backendUrl = requireDevBackend(opts);
  const workspaceKey = opts.workspaceKey ?? canonicalizeBackendUrl(backendUrl);
  const workspaceDir = ensureWorkspace(workspaceKey);
  writeWorkspaceMeta(workspaceDir, backendUrl, workspaceKey);
  return workspaceDir;
}

function requireDevBackend(opts: SetupWorkspaceOptions): string {
  if (!opts.backendUrl)
    throw new Error("A dev workspace is set up from a backend URL");
  return opts.backendUrl;
}

function workspaceSource(
  opts: SetupWorkspaceOptions,
  workspaceDir: string,
): Promise<WorkspaceSource> {
  if (opts.mode === "build") {
    if (!opts.project) throw new Error("A build reads a project");
    return projectLayers(opts.project);
  }
  if (opts.project)
    return projectLayersInDev(
      opts,
      opts.project,
      requireDevBackend(opts),
      workspaceDir,
    );
  return servedLayers(opts, requireDevBackend(opts), workspaceDir);
}

/**
 * Full workspace setup: resolve the frontend modules (from the project in
 * build and dev, completed in dev by the backend's manifest; from the
 * manifest alone for `prepare`), check that each supports this loader
 * release, copy templates, write the workspace package.json
 * with `workspace:*` deps, materialize each module under
 * `<workspace>/frontend-modules/<safeName>/`, write the generated module
 * registry and dms-main.css, and install deps.
 *
 * `materializeLayers` wipes and recreates `<workspace>/frontend-modules/` from
 * the current module set, and must run before `pnpm install` so pnpm sees the
 * workspace packages.
 */
export async function setupWorkspace(
  opts: SetupWorkspaceOptions,
): Promise<SetupWorkspaceResult> {
  const workspaceDir = workspaceDirFor(opts);
  const { fromCache, fetchedAt, layers, secrets } = await workspaceSource(
    opts,
    workspaceDir,
  );

  assertLayersSupportRenderer(layers, { workspaceDir });

  copyStaticTemplates(workspaceDir);
  writeWorkspacePackageJson(workspaceDir, layers);
  materializeLayers(workspaceDir, layers);
  writeDerivedOutputs(workspaceDir, layers);
  writeDmsMainCss(workspaceDir, layers);

  const layerPaths = layers.map((layer) => layer.path);
  const shouldInstall =
    opts.install !== false &&
    needsInstall(workspaceDir, layerPaths, opts.force);

  if (shouldInstall) {
    await opts.beforeInstall?.();
    await installDeps(workspaceDir, createPathMapper(workspaceDir, layers));
    saveDepsHash(workspaceDir, layerPaths);
  }

  return {
    workspaceDir,
    layers,
    manifestFromCache: fromCache,
    manifestFetchedAt: fetchedAt,
    manifestSecrets: secrets,
  };
}

/** Debounce window for coalescing a burst of watcher events into one apply. */

/**
 * The registry and what derives from it. A locale file it refuses is named at
 * its source, the file to edit, rather than at its copy in the workspace.
 */
function writeDerivedOutputs(
  workspaceDir: string,
  layers: ResolvedLayer[],
): void {
  try {
    writeFrontendModuleRegistry(workspaceDir, layers);
  } catch (error) {
    if (!(error instanceof InvalidLocaleFileError)) throw error;
    const showSource = createPathMapper(workspaceDir, layers);
    throw new InvalidLocaleFileError(
      showSource(error.path),
      error.reason,
      error.details,
    );
  }
}
