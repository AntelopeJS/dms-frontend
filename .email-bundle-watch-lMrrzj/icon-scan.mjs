import { relative, sep } from "node:path";

/** What `@nuxt/icon`'s `IconUsageScanner` reads when given no `globInclude`. */
const DEFAULT_SCAN_GLOBS = ["**/*.{vue,jsx,tsx,md,mdc,mdx,yml,yaml}"];

/**
 * The scripts of a frontend source root that may name an icon: its
 * `app.config.ts` (the `ui.icons` mappings) and any icon a composable or a
 * constant names in TypeScript. Limited to `app/`, so a module's tests,
 * fixtures and tooling never reach the client bundle.
 */
const SOURCE_SCRIPT_GLOB = "app/**/*.ts";

/**
 * The `globInclude` of the Nuxt UI client-bundle icon scan.
 *
 * The scanner walks the Vite root, with globs relative to it, and by default
 * skips `.ts` files: every icon a layer names only in TypeScript was then
 * fetched from the Iconify API at run time. Every frontend source root lives
 * under the workspace (`frontend-modules/`, enforced when the registry is
 * written), so a relative glob reaches it. Globs are POSIX on every platform.
 */
export function iconScanGlobs(viteRoot, sourceRoots) {
  const sourceGlobs = sourceRoots.map((root) =>
    [
      ...relative(viteRoot, root).split(sep).filter(Boolean),
      SOURCE_SCRIPT_GLOB,
    ].join("/"),
  );
  return [...DEFAULT_SCAN_GLOBS, ...sourceGlobs];
}
