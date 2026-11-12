import * as icons from "./icons.mjs";

/** @typedef {import("vite").ViteDevServer} ViteDevServer */

/**
 * A URL, not a path: on Windows, `import()` reads `C:\...` as a URL whose
 * scheme is `c:` and refuses it.
 */
const BUILT_SSR_RENDERER_URL = new URL(
  "../dist/ssr/ssr-renderer.js",
  import.meta.url,
);

/** @type {Promise<typeof import("../ssr-renderer.ts")> | undefined} */
let productionSsrRenderer;

/**
 * The SSR renderer of the workspace: the development server's module, else
 * the built bundle, loaded once.
 *
 * @param {ViteDevServer | undefined} devServer
 * @returns {Promise<typeof import("../ssr-renderer.ts")>}
 */
export async function ssrRenderer(devServer) {
  // SAFETY: both load this template's own `ssr-renderer.ts`, the development server from its source and the production import from its build; `ssrLoadModule` types every module `Record<string, any>` and the built URL is computed at run time.
  const renderer = /** @type {typeof import("../ssr-renderer.ts")} */ (
    devServer
      ? await devServer.ssrLoadModule("/ssr-renderer.ts")
      : await (productionSsrRenderer ??= import(BUILT_SSR_RENDERER_URL.href))
  );
  await icons.provideIconCollections(renderer);
  return renderer;
}
