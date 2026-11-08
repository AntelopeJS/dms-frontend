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
 * A layer's own `pnpm.overrides`, with each relative `file:` or `link:` path
 * resolved from the layer's source, since pnpm reads overrides only from the
 * workspace root.
 */
function readLayerOverrides(layer: ResolvedLayer): [string, string][] {
  const packagePath = join(layer.path, "package.json");
  if (!existsSync(packagePath)) return [];
  const packageData: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (!isPlainObject(packageData) || !isPlainObject(packageData.pnpm))
    return [];
  const { overrides } = packageData.pnpm;
  if (!isPlainObject(overrides)) return [];
  return Object.entries(overrides).flatMap(
    ([name, spec]): [string, string][] => {
      if (!isText(spec)) return [];
      const protocol = PATH_PROTOCOLS.find((prefix) => spec.startsWith(prefix));
      if (!protocol) return [[name, spec]];
      const path = spec.slice(protocol.length);
      return [
        [
          name,
          isAbsolute(path) ? spec : `${protocol}${resolve(layer.path, path)}`,
        ],
      ];
    },
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
