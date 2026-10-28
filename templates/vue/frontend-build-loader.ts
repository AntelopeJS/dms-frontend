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

/** The keys of a Vite plugin that hold a value, not a function Vite calls. */
const PLUGIN_PROPERTIES = new Set([
  "name",
  "enforce",
  "apply",
  "sharedDuringBuild",
  "perEnvironmentState",
  "api",
]);

/** The hooks whose function result is itself a hook, run after the server starts. */
const SERVER_HOOKS = new Set(["configureServer", "configurePreviewServer"]);

const attributedErrors = new WeakSet<object>();

/** The fields of a Rollup or Vite error that diagnostics and the overlay read. */
const ERROR_FIELDS = [
  "id",
  "loc",
  "frame",
  "plugin",
  "pluginCode",
  "hook",
  "code",
] as const;

/**
 * A new error naming the module, with the original as its cause: the original
 * may be frozen. It carries the original's diagnostic fields and its stack
 * frames, so the error still points at the file and the line.
 */
function attribute(label: string, error: unknown): Error {
  if (error instanceof Error && attributedErrors.has(error)) return error;
  const message = error instanceof Error ? error.message : String(error);
  const attributed = new Error(`Frontend module ${label}: ${message}`, {
    cause: error,
  });
  attributedErrors.add(attributed);
  if (!(error instanceof Error)) return attributed;
  for (const field of ERROR_FIELDS) {
    if (field in error)
      Reflect.set(attributed, field, Reflect.get(error, field));
  }
  const frames = error.stack?.split(error.message).slice(1).join(error.message);
  if (frames !== undefined && error.stack?.includes(error.message)) {
    attributed.stack = `${error.name}: ${attributed.message}${frames}`;
  }
  return attributed;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function attributedHook(
  label: string,
  hook: unknown,
  returnsHook: boolean,
): unknown {
  if (typeof hook === "function") {
    const attributedResult = (result: unknown): unknown =>
      returnsHook ? attributedHook(label, result, false) : result;
    return function (this: unknown, ...args: unknown[]) {
      try {
        const result: unknown = hook.apply(this, args);
        if (isThenable(result)) {
          return Promise.resolve(result).then(
            attributedResult,
            (error: unknown) => {
              throw attribute(label, error);
            },
          );
        }
        return attributedResult(result);
      } catch (error) {
        throw attribute(label, error);
      }
    };
  }
  if (typeof hook === "object" && hook !== null && "handler" in hook) {
    return {
      ...hook,
      handler: attributedHook(label, hook.handler, returnsHook),
    };
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

/** Every property name of an object, inherited ones included. */
function propertyNames(plugin: object): Set<string> {
  const names = new Set<string>();
  for (
    let object: object | null = plugin;
    object !== null && object !== Object.prototype;
    object = Object.getPrototypeOf(object)
  ) {
    for (const name of Object.getOwnPropertyNames(object)) {
      if (name !== "constructor") names.add(name);
    }
  }
  return names;
}

/**
 * A copy of the plugin whose hooks, own or inherited from its class, name the
 * module in the errors they throw. The module's own object is left as it is.
 */
function attributedPlugin(label: string, plugin: Plugin): Plugin {
  const copy: Record<string, unknown> = {};
  for (const key of propertyNames(plugin)) {
    const value: unknown = Reflect.get(plugin, key);
    copy[key] = PLUGIN_PROPERTIES.has(key)
      ? value
      : attributedHook(label, value, SERVER_HOOKS.has(key));
  }
  if (!isPlugin(copy)) throw invalidPlugins(label);
  return copy;
}

function invalidPlugins(label: string): Error {
  return new Error(
    `Frontend module ${label} registered Vite plugins that are not valid: the function given to registerVitePlugins must return an array of Vite plugin objects, each with a name (false, null and undefined entries are skipped, nested arrays are flattened), or nothing.`,
  );
}

function flattened(label: string, entries: readonly unknown[]): Plugin[] {
  return entries.flatMap((entry): Plugin[] => {
    if (entry === false || entry === null || entry === undefined) return [];
    if (Array.isArray(entry)) return flattened(label, entry);
    if (isThenable(entry)) throw promisedPlugins(label);
    if (!isPlugin(entry)) throw invalidPlugins(label);
    return [entry];
  });
}

function promisedPlugins(label: string): Error {
  return new Error(
    `Frontend module ${label} registered Vite plugins as a Promise: Vite's configuration is built synchronously, so the function given to registerVitePlugins must return the plugins themselves, not a Promise.`,
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
  if (isThenable(created)) throw promisedPlugins(label);
  if (!Array.isArray(created)) throw invalidPlugins(label);
  return flattened(label, created);
}

/**
 * The Vite plugins the modules registered with `registerVitePlugins`, in module
 * order and then call order. Each module's factories run here, in the build
 * process. A factory that throws, returns a Promise, or returns anything but an
 * array of plugin objects (or nothing) fails with a message naming the module,
 * and so does an error thrown by a hook of one of its plugins. As in a Vite
 * configuration, false, null and undefined entries are skipped and nested
 * arrays are flattened.
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
      createdPlugins(label, create).map((plugin) =>
        attributedPlugin(label, plugin),
      ),
    );
  });
}
