import { inertiaAppHtml, isSsrPage } from "./inertia.mjs";
import { ssrRenderer } from "./ssr-module.mjs";
import { isNumber, isObjectLike } from "./type-guards.mjs";

/** @typedef {import("./inertia.mjs").InertiaPage} InertiaPage */
/** @typedef {import("../ssr-renderer.ts").DmsSsrResult} DmsSsrResult */

/**
 * The page document's app for the client to render, with nothing rendered on
 * the server.
 *
 * @param {InertiaPage} page
 * @returns {DmsSsrResult}
 */
export function clientRenderedShell(page) {
  return {
    body: inertiaAppHtml(page),
    head: { headTags: "", htmlAttrs: "", bodyAttrs: "" },
    overlays: "",
    modules: [],
  };
}

/**
 * The page rendered on the server, or the client-rendered shell when the
 * render fails: with the page's own error status when it is an error page,
 * else 500.
 *
 * @param {InertiaPage} page
 * @param {import("./in-place-render.mjs").ServerReads} serverFetch
 * @param {string | undefined} requestCookies
 * @param {import("vite").ViteDevServer | undefined} devServer
 * @returns {Promise<DmsSsrResult>}
 */
export async function serverRendered(
  page,
  serverFetch,
  requestCookies,
  devServer,
) {
  try {
    const renderer = await ssrRenderer(devServer);
    if (!isSsrPage(page))
      throw new TypeError("The page has no path and no page props to render");
    return await renderer.renderDmsPage(page, serverFetch, requestCookies);
  } catch (error) {
    console.error(
      "DMS SSR render failed; falling back to client rendering",
      error,
    );
    const { error: pageError } = page.props;
    const statusCode =
      isObjectLike(pageError) && isNumber(pageError.statusCode)
        ? pageError.statusCode
        : 500;
    return { ...clientRenderedShell(page), error: { statusCode } };
  }
}
