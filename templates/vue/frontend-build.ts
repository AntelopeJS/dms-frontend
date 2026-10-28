import type { Plugin } from "vite";

/**
 * What a frontend module's `dms.frontend.build.ts` declares about how the
 * application is built from it. Read when Vite starts, by `ajs dms dev` and
 * `ajs dms build` alike.
 */
export interface DmsFrontendBuild {
  /**
   * Makes every export of the files under these directories available to
   * the whole application without an import, in scripts and templates.
   *
   * Each entry is a directory relative to the module root, and may hold glob
   * patterns: `layers/*\/app/composables` covers that directory of every
   * layer. Nothing under an `app/build/` directory is ever auto-imported: it
   * holds the module's private code, which its own files import by path.
   */
  registerAutoImports(directories: readonly string[]): void;

  /**
   * Adds Vite plugins to the application's build, for `ajs dms dev`,
   * `ajs dms build` and the preview alike.
   *
   * `create` runs in the build process each time Vite loads its configuration,
   * and returns real Vite plugin objects (an array, each with a `name`) or
   * nothing. They come after the renderer's own plugins, in module order, then
   * in the order of the calls. A value that is not an array of plugin objects,
   * or an error thrown by `create` or by any hook of a plugin, fails Vite with
   * a message that names the module.
   */
  registerVitePlugins(create: () => readonly Plugin[] | undefined): void;
}

export type DmsFrontendBuildSetup = (build: DmsFrontendBuild) => void;

/**
 * Declares how the application is built from a frontend module, as the
 * default export of its `dms.frontend.build.ts`:
 *
 * ```ts
 * import { defineDmsFrontendBuild } from "#dms/frontend-build";
 *
 * export default defineDmsFrontendBuild((build) => {
 *   build.registerAutoImports(["layers/*\/app/composables"]);
 *   build.registerVitePlugins(() => [boundaryPlugin()]);
 * });
 * ```
 *
 * A module without this file has nothing auto-imported and adds no plugin. The file runs in
 * Node.js when Vite starts, not in the application: it may import Node.js
 * built-ins, never the application's own code.
 */
export function defineDmsFrontendBuild(
  setup: DmsFrontendBuildSetup,
): DmsFrontendBuildSetup {
  return setup;
}
