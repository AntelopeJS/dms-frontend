/**
 * @typedef {object} IconsPluginContext
 * @property {{ config: { consumer: string } }} environment
 * @property {(message: string) => never} error
 */

/** Nuxt UI's plugin that installs the client icon bundle. */
const ICONS_PLUGIN = /\/@nuxt\/ui\/dist\/runtime\/vue\/plugins\/icons\.js$/;

/**
 * The client build of Nuxt UI's icons plugin, as a Vite plugin.
 *
 * The plugin imports the bundle of every icon the sources name, which put it
 * in the entry of every page, the sign-in page's included, for icons it draws
 * from the server render's own copy. The client gets an empty plugin, and
 * `loadIconBundle` (`icon-bundle.ts`) loads the bundle when the page needs it. The server render keeps the plugin as it is. The
 * build fails if Nuxt UI changes the form rewritten here, rather than
 * letting the bundle return to the entry unnoticed.
 *
 * @param {(id: string) => boolean} isNuxtUiFile whether a module is Nuxt UI's
 * @returns {{ name: string, enforce: "pre", transform: (this: IconsPluginContext, code: string, id: string) => { code: string, map: null } | null }}
 */
export function uiLazyIcons(isNuxtUiFile) {
  return {
    name: "dms-ui-lazy-icons",
    enforce: "pre",
    transform(code, id) {
      const path = id.replaceAll("\\", "/").split("?")[0];
      if (
        this.environment.config.consumer !== "client" ||
        !isNuxtUiFile(id) ||
        !ICONS_PLUGIN.test(path)
      )
        return null;
      if (!code.includes("virtual:nuxt-ui-icons"))
        this.error(
          `${id} no longer installs the client icon bundle the way the DMS ` +
            "defers it: the bundle would return to the entry. Update " +
            "ui-lazy-icons.mjs for this Nuxt UI release.",
        );
      return { code: "export default { install() {} };", map: null };
    },
  };
}
