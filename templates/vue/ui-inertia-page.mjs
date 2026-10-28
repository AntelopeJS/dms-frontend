const INERTIA_PAGE_IMPORT =
  /import\s*\{\s*usePage\s*\}\s*from\s*["']@inertiajs\/vue3["']/g;
const DMS_PAGE_IMPORT =
  'import { useDmsInertiaPage as usePage } from "#dms/frontend-module"';
/** Any import of `usePage` from Inertia, aliased or among other names. */
const ANY_INERTIA_PAGE_IMPORT =
  /import\s*\{[^}]*\busePage\b[^}]*\}\s*from\s*["']@inertiajs\/vue3["']|import\s*\*\s*as\s+\w+\s+from\s*["']@inertiajs\/vue3["']/;

/**
 * The rewrite, as a Vite plugin.
 *
 * Nuxt UI reads Inertia's page (`usePage()`) for its links and route stub.
 * Inertia's page is module state, shared by the concurrent requests of a
 * server: a render could read another request's URL. Nuxt UI's files read the
 * DMS's per-request page instead, and the build fails if one reads Inertia's in
 * a form this rewrite does not know, rather than letting the leak come back
 * unnoticed with a Nuxt UI release.
 *
 * @param isNuxtUiFile `(id) => boolean`, whether a module is Nuxt UI's
 */
export function uiInertiaPage(isNuxtUiFile) {
  return {
    name: "dms-ui-inertia-page",
    enforce: "pre",
    transform(code, id) {
      if (!isNuxtUiFile(id) || !code.includes("@inertiajs/vue3")) return null;
      const rewritten = code.replace(INERTIA_PAGE_IMPORT, DMS_PAGE_IMPORT);
      if (ANY_INERTIA_PAGE_IMPORT.test(rewritten))
        this.error(
          `${id} reads Inertia's page in a form the DMS does not rewrite: ` +
            "a server render could read another request's URL. Update " +
            "ui-inertia-page.mjs for this Nuxt UI release.",
        );
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}
