/** Nuxt UI's key hint composable. */
const USE_KBD = /\/@nuxt\/ui\/dist\/runtime\/composables\/useKbd\.js$/;
/** Its export as Nuxt UI 4 writes it: one composable shared by every hint. */
const SHARED_EXPORT =
  /export const useKbd = \/\* @__PURE__ \*\/ createSharedComposable\(_useKbd\);/;
const ROUTED_EXPORT =
  'import { useDmsKbd } from "#dms/frontend-module";\n' +
  "const useSharedKbd = /* @__PURE__ */ createSharedComposable(_useKbd);\n" +
  "export const useKbd = () => useDmsKbd(useSharedKbd, kbdKeysMap);";

/**
 * The rewrite, as a Vite plugin.
 *
 * Nuxt UI prints the `meta`, `ctrl` and `alt` of a key hint (`UKbd`, the `kbds`
 * of its menus) from a map every hint shares, blank until the first hint
 * mounts: a hint hydrating after that, in an async component, printed "⌘" or
 * "Ctrl" over the server's blank, a hydration mismatch on every platform. Its
 * `useKbd` is routed to the DMS runtime's `useDmsKbd`, which keeps each hint on
 * the server's value until it mounts and lets the application give the platform
 * to the server render (`provideDmsKbdPlatform`). The build fails if Nuxt UI
 * changes the form rewritten here, rather than letting the mismatch come back
 * unnoticed.
 *
 * @param isNuxtUiFile `(id) => boolean`, whether a module is Nuxt UI's
 */
export function uiKbd(isNuxtUiFile) {
  return {
    name: "dms-ui-kbd",
    enforce: "pre",
    transform(code, id) {
      const path = id.replaceAll("\\", "/").split("?")[0];
      if (!isNuxtUiFile(id) || !USE_KBD.test(path)) return null;
      if (
        !SHARED_EXPORT.test(code) ||
        !code.includes("export const kbdKeysMap")
      )
        this.error(
          `${id} defines useKbd in a form the DMS does not rewrite: its key ` +
            "hints would not hydrate cleanly. Update ui-kbd.mjs for this " +
            "Nuxt UI release.",
        );
      return { code: code.replace(SHARED_EXPORT, ROUTED_EXPORT), map: null };
    },
  };
}
