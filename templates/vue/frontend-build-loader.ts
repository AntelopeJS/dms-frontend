import { isAbsolute, posix, resolve } from "node:path";
import { normalizePath } from "vite";
import type { DmsFrontendBuildSetup } from "./frontend-build";

/** A module's `dms.frontend.build.ts`, as the generated loader imports it. */
export interface FrontendBuildDeclaration {
  /** The module's id in the generated module registry. */
  id: string;
  setup: DmsFrontendBuildSetup;
}

interface FrontendModuleRoot {
  id: string;
  root: string;
}

export interface AutoImportDirectory {
  glob: string;
  types: boolean;
}

/** A module's private code: never auto-imported, whatever it declares. */
const PRIVATE_DIRECTORY = /(?:^|\/)app\/build(?:\/|$)/;

function declaredDirectories(setup: DmsFrontendBuildSetup): string[] {
  const directories: string[] = [];
  setup({
    registerAutoImports: (entries) => directories.push(...entries),
  });
  return directories;
}

function rejection(directory: string): string | undefined {
  const path = posix.normalize(normalizePath(directory));
  if (isAbsolute(directory) || path === ".." || path.startsWith("../"))
    return "it is not inside the module";
  if (PRIVATE_DIRECTORY.test(path))
    return "app/build/ holds the module's private code, which is never auto-imported";
  return undefined;
}

/**
 * The directories the modules declared in their `dms.frontend.build.ts`, as
 * the auto-importer's scan globs. Each module's `app/build/` directories are
 * excluded even from a broader declaration; a declaration naming one, or
 * leaving the module, is ignored with a warning.
 *
 * Globs are POSIX on every platform: the scanner reads a backslash as an
 * escape, not as a separator.
 */
export function autoImportDirectories(
  modules: readonly FrontendModuleRoot[],
  declarations: readonly FrontendBuildDeclaration[],
  warn: (message: string) => void,
): AutoImportDirectory[] {
  const roots = new Map(modules.map((module) => [module.id, module.root]));
  return declarations.flatMap(({ id, setup }) => {
    const root = roots.get(id);
    if (root === undefined) return [];
    const scan = (pattern: string) => normalizePath(resolve(root, pattern));
    const accepted = declaredDirectories(setup).filter((directory) => {
      const reason = rejection(directory);
      if (reason)
        warn(
          `Frontend module ${id} declares "${directory}" for auto-import, which is ignored: ${reason}.`,
        );
      return !reason;
    });
    if (accepted.length === 0) return [];
    return [
      ...accepted.map((directory) => ({
        glob: scan(`${directory}/**/*`),
        types: true,
      })),
      { glob: `!${scan("**/app/build/**")}`, types: true },
    ];
  });
}
