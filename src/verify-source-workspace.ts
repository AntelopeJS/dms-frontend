import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse, parseAllDocuments } from "yaml";
import {
  createFrontendModuleRegistry,
  getPackageRoot,
  materializeLayers,
  type ResolvedLayer,
  writeFrontendModuleRegistry,
  writeWorkspacePackageJson,
} from "./common";
import { ensure } from "./internal/ensure";
import { isText } from "./internal/guards";
import { isPlainObject } from "./internal/plain-object";
import { showPath } from "./output";

function removeDevelopmentDependencies(root: string): void {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return;
  const packageData: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!isPlainObject(packageData)) return;
  delete packageData.devDependencies;
  writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
}

/** The pnpm protocols whose spec is a path, relative to the project. */
const PATH_PROTOCOLS = ["file:", "link:"];
/**
 * The protocol of a package of the layer's own pnpm workspace, which the
 * generated workspace holds only for the layers it binds itself.
 */
const WORKSPACE_PROTOCOL = "workspace:";
const LOCKFILE = "pnpm-lock.yaml";
const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** The `.npmrc` line that gives each workspace project its own lockfile. */
const OWN_LOCKFILES = /^\s*shared-workspace-lockfile\s*=\s*false\s*$/m;

/** The nearest directory from `directory` up that holds `file`. */
function findUp(directory: string, file: string): string | undefined {
  if (existsSync(join(directory, file))) return directory;
  const parent = dirname(directory);
  return parent === directory ? undefined : findUp(parent, file);
}

/** Whether the projects of the pnpm workspace at `root` share its lockfile. */
function sharesLockfile(root: string): boolean {
  const npmrc = join(root, ".npmrc");
  if (existsSync(npmrc) && OWN_LOCKFILES.test(readFileSync(npmrc, "utf8")))
    return false;
  const settings: unknown = parse(
    readFileSync(join(root, WORKSPACE_FILE), "utf8"),
  );
  return !(
    isPlainObject(settings) && settings.sharedWorkspaceLockfile === false
  );
}

/**
 * The lockfile pnpm installs `directory` from: that of the pnpm workspace it
 * belongs to, unless the workspace gives each project its own, in which case
 * the nearest one up to the workspace root.
 */
function findLockfile(directory: string): string | undefined {
  const workspaceRoot = findUp(directory, WORKSPACE_FILE);
  const lockfileRoot =
    workspaceRoot && sharesLockfile(workspaceRoot)
      ? workspaceRoot
      : findUp(directory, LOCKFILE);
  if (!lockfileRoot) return undefined;
  const lockfile = join(lockfileRoot, LOCKFILE);
  const outsideWorkspace =
    workspaceRoot !== undefined &&
    relative(workspaceRoot, lockfileRoot).startsWith("..");
  return existsSync(lockfile) && !outsideWorkspace ? lockfile : undefined;
}

/**
 * The overrides the install of a layer applied, as its lockfile records them,
 * with each relative `file:` or `link:` path resolved from the lockfile's
 * directory. The lockfile already holds what pnpm read from the
 * `package.json` and `pnpm-workspace.yaml` files that apply to the layer,
 * with every `$<name>` resolved; pnpm reads overrides only from the root of
 * the workspace verify-source installs. A `workspace:` override names a
 * package of the layer's own workspace, which the generated one lacks.
 */
function readLayerOverrides(layer: ResolvedLayer): [string, string][] {
  const lockfile = findLockfile(layer.path);
  if (!lockfile) return [];
  const root = dirname(lockfile);
  const overrides: [string, string][] = [];
  for (const document of parseAllDocuments(readFileSync(lockfile, "utf8"))) {
    const [error] = document.errors;
    ensure(
      error === undefined,
      `${showPath(lockfile)} is not a pnpm lockfile`,
      error?.message,
    );
    const lock: unknown = document.toJS();
    if (!isPlainObject(lock) || !isPlainObject(lock.overrides)) continue;
    for (const [name, spec] of Object.entries(lock.overrides)) {
      if (!isText(spec) || spec.startsWith(WORKSPACE_PROTOCOL)) continue;
      overrides.push([name, resolveSpec(root, spec)]);
    }
  }
  return overrides;
}

/** `spec` with a relative `file:` or `link:` path resolved from `root`. */
function resolveSpec(root: string, spec: string): string {
  const protocol = PATH_PROTOCOLS.find((prefix) => spec.startsWith(prefix));
  if (!protocol) return spec;
  const path = spec.slice(protocol.length);
  return isAbsolute(path) ? spec : `${protocol}${resolve(root, path)}`;
}

/**
 * Fills `workspace` with the renderer template and `layers`, carries the
 * overrides the layers were installed with, and points the layers and `localPackages` at
 * their copies through `pnpm.overrides`, over any layer override.
 */
export function materializeWorkspace(
  workspace: string,
  layers: ResolvedLayer[],
  localPackages: Record<string, string>,
) {
  const templateRoot = join(getPackageRoot(), "templates", "vue");
  const templateFiles = readdirSync(templateRoot).filter(
    (file) => !file.startsWith("npmrc"),
  );
  for (const file of templateFiles)
    cpSync(join(templateRoot, file), join(workspace, file), {
      recursive: true,
    });
  materializeLayers(workspace, layers);
  const registry = createFrontendModuleRegistry(workspace, layers);
  registry.modules.forEach((module) => {
    removeDevelopmentDependencies(module.root);
  });
  writeFrontendModuleRegistry(workspace, layers);
  writeFileSync(
    join(workspace, "dms-main.css"),
    '@import "tailwindcss";\n@import "@nuxt/ui";\n',
  );
  writeWorkspacePackageJson(workspace, layers);
  const packagePath = join(workspace, "package.json");
  const workspacePackage: unknown = JSON.parse(
    readFileSync(packagePath, "utf8"),
  );
  ensure(
    isPlainObject(workspacePackage),
    "The workspace package.json is not a JSON object",
  );
  workspacePackage.pnpm = {
    overrides: {
      ...Object.fromEntries(layers.flatMap(readLayerOverrides)),
      ...Object.fromEntries(
        layers.map((layer): [string, string] => [
          String(layer.packageName),
          "workspace:*",
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(localPackages).map(([name, path]) => [
          name,
          `link:${resolve(path)}`,
        ]),
      ),
    },
  };
  writeFileSync(packagePath, `${JSON.stringify(workspacePackage, null, 2)}\n`);
}
