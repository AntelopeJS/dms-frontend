/** Nuxt UI's stub of Nuxt's composables, which defines `useState`. */
const STUB = /\/@nuxt\/ui\/dist\/runtime\/vue\/stubs\/base\.js$/;
/** `useState` as Nuxt UI 4 defines it: a module-wide record of refs. */
const MODULE_STATE =
  /const state = \{\};\s*export const useState = \(key, init\) => \{\s*if \(state\[key\]\) \{\s*return state\[key\];\s*\}\s*const value = ref\(init\(\)\);\s*state\[key\] = value;\s*return value;\s*\};/;
/** A definition of `useState`, wherever Nuxt UI moves it. */
const DEFINES_USE_STATE = /export\s+(?:const|function|let|var)\s+useState\b/;
const APPLICATION_STATE =
  'import { useDmsState } from "#dms/frontend-module";\n' +
  "export const useState = (key, init) => useDmsState(`nuxt-ui:${key}`, init);";

/**
 * The rewrite, as a Vite plugin.
 *
 * Nuxt UI's `useState` outside Nuxt keeps its state in one object for the whole
 * module: on a server, for the whole process. A toast one render adds
 * (`useToast()` keeps its list there) would then show in every later render,
 * whoever asks for the page, until the server restarts. Nuxt UI's stub keeps
 * its state in the DMS's per-application state instead, as Nuxt's own
 * `useState` does, and the build fails if the stub changes form or another Nuxt
 * UI file defines `useState`, rather than letting the leak come back unnoticed
 * with a Nuxt UI release.
 *
 * @param {(id: string) => boolean} isNuxtUiFile whether a module is Nuxt UI's
 * @returns {import("./ui-inertia-page.mjs").NuxtUiRewrite}
 */
export function uiRequestState(isNuxtUiFile) {
  return {
    name: "dms-ui-request-state",
    enforce: "pre",
    transform(code, id) {
      const path = id.replaceAll("\\", "/").split("?")[0];
      if (!isNuxtUiFile(id)) return null;
      if (!STUB.test(path)) {
        if (DEFINES_USE_STATE.test(code))
          this.error(
            `${id} defines useState outside the stub the DMS rewrites: a ` +
              "server render could show another request's state. Update " +
              "ui-request-state.mjs for this Nuxt UI release.",
          );
        return null;
      }
      if (!MODULE_STATE.test(code)) {
        if (!code.includes("useState")) return null;
        this.error(
          `${id} defines useState in a form the DMS does not rewrite: a ` +
            "server render could show another request's state. Update " +
            "ui-request-state.mjs for this Nuxt UI release.",
        );
      }
      return { code: code.replace(MODULE_STATE, APPLICATION_STATE), map: null };
    },
  };
}
