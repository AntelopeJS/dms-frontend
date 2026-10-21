// How the client bundle is cut into files, and what the build says about it.
//
// Kept beside vite.config.ts rather than inside it so the options can be
// exercised on their own, the way head-order.mjs and client-server-guard.mjs are.

/**
 * Rolldown's `output.codeSplitting` for the client build.
 *
 * By default Rolldown gives every set of dynamic imports that shares a module
 * its own common chunk. The DMS's pages are hundreds of dynamic imports (a
 * module's components and pages are `import.meta.glob`ed), so the code the
 * entry also needs lands in about sixty small common chunks the entry imports
 * before anything runs: one request each, 55 to 60 more files on every page
 * than the single entry file Rollup made, for no byte saved.
 *
 * The `$initial` tag is every module the entry imports statically, directly or
 * not. One group over it puts them in the entry file again, and leaves every
 * lazy chunk to Rolldown's own splitting, which a page only loads when it needs
 * it: what an anonymous page loads is still what that page's own routes pull.
 *
 * Deliberately not here: groups over what the lazy chunks share (the UI
 * libraries, a chunk per module). They cut a signed-in page's files by a
 * quarter to four fifths, but every group is loaded whole by each page that
 * uses any of it, and the anonymous pages pay 70 to 115 KB of Brotli for code
 * only the signed-in shell uses.
 */
export const clientCodeSplitting = {
  groups: [{ name: "entry", tags: ["$initial"] }],
};

const MODULE_ENTRY = /[\\/]dms\.frontend\.[cm]?[jt]sx?$/;

/**
 * Rolldown's `onLog` for every build: drops the
 * INEFFECTIVE_DYNAMIC_IMPORT notices whose dynamic importer is a module's
 * `dms.frontend.ts`.
 *
 * That file `import.meta.glob`s every component of the module so a page can
 * resolve one by name. A few of them (StatusPill, MonoCell, IdentityCell: the
 * table cell renderers) are also imported statically by the entry, which is
 * what a cell renderer needs at hydration. The glob entry then resolves to the
 * chunk already loaded: nothing is duplicated and nothing was meant to be
 * lazy, and nobody can act on the notice. A `import()` a module author
 * writes by hand for a file that is also imported statically is the same
 * mistake with a different cause (the lazy load never happens), and still
 * warns.
 *
 * @param {string} level
 * @param {{ code?: string, ids?: string[] }} log
 * @param {(level: string, log: object) => void} defaultHandler
 */
export function onBuildLog(level, log, defaultHandler) {
  if (
    log.code === "INEFFECTIVE_DYNAMIC_IMPORT" &&
    log.ids?.length &&
    MODULE_ENTRY.test(log.ids[0])
  ) {
    return;
  }
  defaultHandler(level, log);
}
