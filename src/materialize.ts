// Writing the workspace out: static templates, its package.json, the
// frontend-module sources copied in, and the generated module registry.
//
// Split out of common.ts, which stays the barrel every command imports from.

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getProcessUi } from "@antelopejs/core/cli";
import {
  AUTH_ESTABLISH_FILE,
  LAYERS_SUBDIR,
  TAILWIND_SOURCE_GLOB,
  TEMPLATE_FILES,
} from "./config";
import {
  createFrontendModuleRegistry,
  DERIVED_OUTPUTS,
} from "./derived-outputs";
import { getLayerWorkspacePath } from "./layers";
import { ResolvedLayer } from "./workspace";

import {
  applyContent,
  isBlocklistedCopyPath,
  sanitizedPackageContent,
  toPosixPath,
} from "./fs-sync";

// ============================================================================
// Constants
// ============================================================================

export function getPackageRoot(): string {
  return resolve(__dirname, "..");
}

function getTemplateDir(): string {
  return join(getPackageRoot(), "templates", "vue");
}

function copyTemplateFile(
  sourceName: string,
  destName: string,
  workspaceDir: string,
): void {
  const src = join(getTemplateDir(), sourceName);
  if (!existsSync(src)) {
    throw new Error(`Template not found: ${src}`);
  }
  const destination = join(workspaceDir, destName);
  mkdirSync(dirname(destination), { recursive: true });
  if (statSync(src).isDirectory()) {
    cpSync(src, destination, { recursive: true });
    return;
  }
  copyFileSync(src, destination);
}

export function copyStaticTemplates(workspaceDir: string): void {
  for (const [sourceName, destName] of TEMPLATE_FILES) {
    copyTemplateFile(sourceName, destName, workspaceDir);
  }
}

/**
 * Write the workspace package.json: start from the template and reference
 * each module via the `workspace:*` protocol. The modules themselves are
 * materialized under `<workspaceDir>/frontend-modules/<safeName>/` (see
 * `materializeLayers`) and declared as workspace packages through
 * `pnpm-workspace.yaml` (`packages: [., frontend-modules/*]`).
 *
 * Why not `file:<path>`: `file:` makes pnpm copy each module into
 * `.pnpm/<pkg>@file+.../node_modules/<pkg>/frontend-modules/...` with its own
 * nested transitive deps. Vue compiler-sfc then compiles .vue files out
 * of that `.pnpm/` snapshot, and its type resolver cannot follow
 * `export * from '../Input.vue'` re-export chains across package
 * boundaries inside `.pnpm/` — the vite-node worker crashes with
 * "IPC connection closed" on any file that uses `defineProps<InputProps>()`
 * or extends an @nuxt/ui props type.
 *
 * With `workspace:*` + a real `frontend-modules/` subdirectory, pnpm hoists
 * every module's transitive deps into `<workspaceDir>/node_modules/` (one
 * cran above each module) and compiler-sfc sees a classic node_modules tree,
 * which is the same topology the old `.components_cache/*` workspace had
 * and which never exhibited this bug.
 */
export function writeWorkspacePackageJson(
  workspaceDir: string,
  layers: ResolvedLayer[],
): void {
  const templatePath = join(getTemplateDir(), "package.json");
  const pkg = JSON.parse(readFileSync(templatePath, "utf-8"));

  pkg.dependencies ??= {};
  for (const layer of layers) {
    if (!layer.packageName) continue;
    pkg.dependencies[layer.packageName] = "workspace:*";
  }

  writeFileSync(
    join(workspaceDir, "package.json"),
    `${JSON.stringify(pkg, null, 2)}\n`,
  );
}

/**
 * Materialize every resolved module inside
 * `<workspaceDir>/frontend-modules/<safeName>/`.
 *
 * We deep-copy the layer source (filtered by its .gitignore, so we don't
 * drag `node_modules`, build output, or caches into the workspace). We do NOT
 * symlink, even in dev mode: pnpm follows realpath when resolving workspace
 * packages, so a symlink would install the layer's transitive deps into the
 * source directory's `node_modules/` instead of the workspace root. That
 * breaks the topology we need for compiler-sfc to resolve cross-package
 * `.vue` re-exports.
 *
 * Trade-off: editing layer source files no longer triggers HMR in the live
 * workspace. A file-level watcher that re-syncs on change can be added on
 * top of this if that becomes a pain point — the old `.components_cache`
 * CLI did exactly that.
 *
 * The `frontend-modules/` directory is declared as a workspace package glob in
 * `pnpm-workspace.yaml`, so `pnpm install` treats each entry as a first-class
 * workspace package and hoists its transitive deps into
 * `<workspaceDir>/node_modules/`.
 */
export function materializeLayers(
  workspaceDir: string,
  layers: ResolvedLayer[],
): void {
  const layersRoot = join(workspaceDir, LAYERS_SUBDIR);

  if (existsSync(layersRoot)) {
    rmSync(layersRoot, { recursive: true, force: true });
  }
  mkdirSync(layersRoot, { recursive: true });

  for (const layer of layers) {
    if (!layer.packageName) continue;
    const dest = getLayerWorkspacePath(workspaceDir, layer);
    copyLayerSource(layer.path, dest);
  }
}

/**
 * Copy a layer's source tree into its destination inside the workspace,
 * filtering out entries that match `LAYER_COPY_BLOCKLIST` at any depth.
 * We deliberately do NOT honor the layer's `.gitignore` — that would make
 * the copy depend on a file the layer author maintains for their own
 * local dev needs and can rightfully use to exclude runtime-relevant
 * files (fixtures, generated manifests, env samples, …). The blocklist
 * is the single source of truth shared with the dev-mode watcher.
 *
 * After copying, we sanitize the layer's `package.json` to strip the
 * pnpm lifecycle scripts (`postinstall`, `prepare`, etc.) that are
 * intended for standalone development of the layer and would otherwise
 * run — and fail — during the workspace `pnpm install`. A typical
 * offender is a postinstall that recursively prepares the generated workspace
 * from inside the copied module. Development
 * dependencies are omitted because the generated host owns its toolchain.
 */
function copyLayerSource(src: string, dest: string): void {
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (srcPath) => !isBlocklistedCopyPath(src, srcPath),
  });

  sanitizeLayerPackage(join(dest, "package.json"));
}

function sanitizeLayerPackage(pkgPath: string): void {
  if (!existsSync(pkgPath)) return;
  applyContent(
    sanitizedPackageContent(readFileSync(pkgPath, "utf-8")),
    pkgPath,
  );
}

/**
 * Absolute backend API paths only: no scheme, no authority, no query string,
 * and no segment that could climb out of `/api/`. Kept character-for-character
 * in sync with the generated server's own grammar, which re-checks every path
 * before calling it.
 */
const BACKEND_API_PATH =
  /^\/api\/[A-Za-z0-9][A-Za-z0-9._~-]*(?:\/[A-Za-z0-9][A-Za-z0-9._~-]*)*$/;

/**
 * The backend endpoints this workspace's modules may open a session from.
 *
 * Each module declares its own on the backend and the manifest carries them
 * here, so a standard deployment needs no `DMS_AUTH_ESTABLISH_ENDPOINTS` at
 * all. A malformed path is dropped rather than fatal: the workspace is
 * materialized from whatever the backend served, and one bad declaration in
 * one module must not stop the frontend from building — the endpoint simply
 * stays refused, which is the safe direction.
 *
 * @param layers Resolved layers, in workspace order
 * @returns The well-formed declared paths, without duplicates
 */
export function collectAuthEstablishEndpoints(
  layers: ResolvedLayer[],
): string[] {
  const endpoints = new Set<string>();
  for (const layer of layers) {
    for (const endpoint of layer.authEstablishEndpoints ?? []) {
      if (typeof endpoint === "string" && BACKEND_API_PATH.test(endpoint)) {
        endpoints.add(endpoint);
        continue;
      }
      getProcessUi().message(
        "warn",
        `Ignoring malformed authEstablishEndpoints entry ${JSON.stringify(endpoint)} ` +
          `declared by ${layer.packageName ?? layer.path}: expected an absolute ` +
          "backend API path under /api/ with no query string.",
      );
    }
  }
  return [...endpoints];
}

/**
 * Write the declared endpoints where the generated server can read them.
 *
 * The server runs with no backend to ask — in production the backend may not
 * even be reachable from it at boot — so the allow-list is baked into the
 * workspace at materialization time, alongside the module registry.
 */
function writeAuthEstablishEndpoints(
  workspaceDir: string,
  layers: ResolvedLayer[],
): void {
  const endpoints = collectAuthEstablishEndpoints(layers);
  writeFileSync(
    join(workspaceDir, AUTH_ESTABLISH_FILE),
    `${JSON.stringify({ endpoints }, null, 2)}\n`,
  );
}

export function writeFrontendModuleRegistry(
  workspaceDir: string,
  layers: ResolvedLayer[],
): void {
  const registry = createFrontendModuleRegistry(workspaceDir, layers);
  writeAuthEstablishEndpoints(workspaceDir, layers);
  for (const output of DERIVED_OUTPUTS) output.write(workspaceDir, registry);
}

/**
 * Generate dms-main.css which imports Tailwind + Nuxt UI and adds
 * `@source` directives so Tailwind scans each module's materialized copy
 * under `<workspace>/frontend-modules/<safeName>/` (NOT the original source
 * path).
 * Pointing at the workspace copy keeps every path on the same drive as
 * the workspace rootDir — otherwise, on Windows, a source tree on a
 * different drive can yield absolute paths where relative paths are required.
 * Scope the scan to extensions Tailwind needs and avoid dependencies, build
 * output, and caches.
 *
 * The path is written into the stylesheet as the prefix of a glob, where a
 * native Windows separator would be read as an escape character and match
 * nothing, so it goes in with POSIX separators.
 */
export function writeDmsMainCss(
  workspaceDir: string,
  layers: ResolvedLayer[],
): void {
  const sources = layers
    .map(
      (layer) =>
        `@source "${toPosixPath(getLayerWorkspacePath(workspaceDir, layer))}/${TAILWIND_SOURCE_GLOB}";`,
    )
    .join("\n");

  const content = `@import "tailwindcss";
@import "@nuxt/ui";
@plugin "@tailwindcss/typography";

${sources}
`;

  writeFileSync(join(workspaceDir, "dms-main.css"), content);
}
