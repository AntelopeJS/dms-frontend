import { isAbsolute, posix, resolve } from "node:path";
import { normalizePath, type Plugin } from "vite";
import type {
  DmsFrontendBuild,
  DmsFrontendBuildSetup,
} from "./frontend-build.ts";

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

interface FrontendModuleName {
  id: string;
  name?: string;
}

type VitePluginFactory = Parameters<DmsFrontendBuild["registerVitePlugins"]>[0];

interface DeclaredBuild {
  directories: string[];
  pluginFactories: VitePluginFactory[];
}

/** Each setup runs once, whichever declaration is read first. */
const declarations = new WeakMap<DmsFrontendBuildSetup, DeclaredBuild>();

function declared(setup: DmsFrontendBuildSetup): DeclaredBuild {
  const known = declarations.get(setup);
  if (known) return known;
  const build: DeclaredBuild = { directories: [], pluginFactories: [] };
  setup({
    registerAutoImports: (entries) => build.directories.push(...entries),
    registerVitePlugins: (create) => build.pluginFactories.push(create),
  });
  declarations.set(setup, build);
  return build;
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
  buildDeclarations: readonly FrontendBuildDeclaration[],
  warn: (message: string) => void,
): AutoImportDirectory[] {
  const roots = new Map(modules.map((module) => [module.id, module.root]));
  return buildDeclarations.flatMap(({ id, setup }) => {
    const root = roots.get(id);
    if (root === undefined) return [];
    const scan = (pattern: string) => normalizePath(resolve(root, pattern));
    const accepted = declared(setup).directories.filter((directory) => {
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

/** Hook-like keys of a Vite plugin that hold a value, not a function Vite calls. */
const PLUGIN_PROPERTIES = new Set([
  "name",
  "enforce",
  "apply",
  "sharedDuringBuild",
  "perEnvironmentState",
  "api",
]);

const attributedErrors = new WeakSet<object>();

function attribute(label: string, error: unknown): unknown {
  if (!(error instanceof Error)) {
    return new Error(`Frontend module ${label}: ${String(error)}`, {
      cause: error,
    });
  }
  if (!attributedErrors.has(error)) {
    attributedErrors.add(error);
    error.message = `Frontend module ${label}: ${error.message}`;
  }
  return error;
}

function attributedHook(label: string, hook: unknown): unknown {
  if (typeof hook === "function") {
    return function (this: unknown, ...args: unknown[]) {
      try {
        const result: unknown = hook.apply(this, args);
        if (result instanceof Promise) {
          return result.catch((error: unknown) => {
            throw attribute(label, error);
          });
        }
        return result;
      } catch (error) {
        throw attribute(label, error);
      }
    };
  }
  if (typeof hook === "object" && hook !== null && "handler" in hook) {
    return { ...hook, handler: attributedHook(label, hook.handler) };
  }
  return hook;
}

function isPlugin(value: unknown): value is Plugin {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "name" in value &&
    typeof value.name === "string" &&
    value.name !== ""
  );
}

function createdPlugins(label: string, create: VitePluginFactory): Plugin[] {
  let created: unknown;
  try {
    created = create();
  } catch (error) {
    throw attribute(label, error);
  }
  if (created === undefined) return [];
  if (!Array.isArray(created) || !created.every(isPlugin)) {
    throw new Error(
      `Frontend module ${label} registered Vite plugins that are not valid: the function given to registerVitePlugins must return an array of Vite plugin objects, each with a name, or nothing.`,
    );
  }
  return created;
}

/**
 * The Vite plugins the modules registered with `registerVitePlugins`, in module
 * order and then call order. Each module's factories run here, in the build
 * process. A factory that throws or returns anything but an array of plugin
 * objects (or nothing) fails with a message naming the module, and so does an
 * error thrown by a hook of one of its plugins. The modules' plugins are
 * copied: a module's own objects are never modified.
 */
export function vitePlugins(
  modules: readonly FrontendModuleName[],
  buildDeclarations: readonly FrontendBuildDeclaration[],
): Plugin[] {
  const names = new Map(
    modules.map((module) => [module.id, module.name ?? module.id]),
  );
  return buildDeclarations.flatMap(({ id, setup }) => {
    const label = names.get(id) ?? id;
    return declared(setup).pluginFactories.flatMap((create) =>
      createdPlugins(label, create).map(
        (plugin): Plugin =>
          Object.fromEntries(
            Object.entries(plugin).map(([key, value]) => [
              key,
              PLUGIN_PROPERTIES.has(key) ? value : attributedHook(label, value),
            ]),
          ) as Plugin,
      ),
    );
  });
}
