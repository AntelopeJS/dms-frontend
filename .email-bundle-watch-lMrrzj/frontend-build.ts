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
 * });
 * ```
 *
 * A module without this file has nothing auto-imported. The file runs in
 * Node.js when Vite starts, not in the application: it may import Node.js
 * built-ins, never the application's own code.
 */
export function defineDmsFrontendBuild(
  setup: DmsFrontendBuildSetup,
): DmsFrontendBuildSetup {
  return setup;
}
