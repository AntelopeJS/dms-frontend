/** The names `frontend-module.ts` gives every module's sources without an import. */
const FRONTEND_MODULE_IMPORTS = [
  "$fetch",
  "abortDmsNavigation",
  "clearDmsError",
  "createDmsError",
  "dmsRequestKey",
  "defineDmsAppConfig",
  "defineDmsPlugin",
  "defineDmsMiddleware",
  "defineDmsPageMeta",
  "navigateDms",
  "preloadDmsComponents",
  "refreshDmsData",
  "refreshDmsPageData",
  "setDmsAsyncDataScope",
  "showDmsError",
  "useDmsAsyncData",
  "useDmsData",
  "useDmsCookie",
  "useDmsFetch",
  "useHead",
  "useI18n",
  "useDmsError",
  "useDmsPagedData",
  "useDmsPageLoading",
  "isDmsHydrating",
  "useDmsApp",
  "useDmsRoute",
  "useDmsRouter",
  "useDmsRuntimeConfig",
  "useSeoMeta",
  "useDmsState",
  "useDmsAppConfig",
  "DmsClientOnly",
  "DmsLink",
  "useDmsUserSession",
  "provideDmsKbdPlatform",
];

/**
 * The `imports` of the workspace's auto-importer: Vue's preset and the names
 * of `frontend-module.ts`. Nuxt UI adds its own composables to them.
 *
 * The auto-importer inlines `frontendModule` verbatim as the specifier of the
 * import it prepends to each file, inside a single-quoted JavaScript string:
 * pass a POSIX path, since a Windows backslash there reads as an escape.
 *
 * @param {string} frontendModule The import specifier of `frontend-module.ts`.
 * @returns {["vue", Record<string, string[]>]}
 */
export function autoImportSources(frontendModule) {
  return ["vue", { [frontendModule]: FRONTEND_MODULE_IMPORTS }];
}
