import {
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
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

function removeDevelopmentDependencies(root: string): void {
  const packagePath = join(root, "package.json");
  if (!existsSync(packagePath)) return;
  const packageData: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!isPlainObject(packageData)) return;
  delete packageData.devDependencies;
  writeFileSync(packagePath, `${JSON.stringify(packageData, null, 2)}\n`);
}

/** The pnpm protocols whose spec is a path, relative to the package. */
const PATH_PROTOCOLS = ["file:", "link:"];
/**
 * The fields a `$<name>` override reads the direct dependency from, each over
 * the ones before it.
 */
const DIRECT_DEPENDENCY_FIELDS = [
  "optionalDependencies",
  "devDependencies",
  "dependencies",
];

/**
 * An override spec as the layer means it: a `$<name>` reference replaced by
 * the layer's direct dependency on `<name>`, and a relative `file:` or `link:`
 * path resolved from the layer's source. A reference to no direct dependency
 * stays as is, and fails the install as it does in the layer.
 */
function resolveLayerSpec(
  layerPath: string,
  directDependencies: ReadonlyMap<string, string>,
  spec: string,
): string {
  const resolved =
    (spec.startsWith("$") && directDependencies.get(spec.slice(1))) || spec;
  const protocol = PATH_PROTOCOLS.find((prefix) => resolved.startsWith(prefix));
  if (!protocol) return resolved;
  const path = resolved.slice(protocol.length);
  return isAbsolute(path) ? resolved : `${protocol}${resolve(layerPath, path)}`;
}

/**
 * A layer's own `pnpm.overrides` as the layer means them, since pnpm reads
 * overrides only from the workspace root.
 */
function readLayerOverrides(layer: ResolvedLayer): [string, string][] {
  const packagePath = join(layer.path, "package.json");
  if (!existsSync(packagePath)) return [];
  const packageData: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!isPlainObject(packageData) || !isPlainObject(packageData.pnpm))
    return [];
  const { overrides } = packageData.pnpm;
  if (!isPlainObject(overrides)) return [];
  const directDependencies = new Map<string, string>();
  for (const field of DIRECT_DEPENDENCY_FIELDS) {
    const dependencies = packageData[field];
    if (!isPlainObject(dependencies)) continue;
    for (const [name, range] of Object.entries(dependencies))
      if (isText(range)) directDependencies.set(name, range);
  }
  return Object.entries(overrides).flatMap(
    ([name, spec]): [string, string][] =>
      isText(spec)
        ? [[name, resolveLayerSpec(layer.path, directDependencies, spec)]]
        : [],
  );
}

/**
 * Fills `workspace` with the renderer template and `layers`, carries the
 * layers' own `pnpm.overrides`, and points the layers and `localPackages` at
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
