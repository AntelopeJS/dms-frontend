// Putting the page's stylesheets in the document the development server
// returns, instead of letting the client entry inject them from JavaScript
// once it has executed.
//
// Vite serves every stylesheet as a JavaScript module in development, so a
// plain SSR document carries no styles at all and the browser paints raw HTML
// until `/main.ts` and its module graph have run. Production has no such gap:
// the built `index.html` already links the entry stylesheet, which is why this
// module is development-only and lives beside client-manifest.mjs rather than
// inside server.mjs, whose size the linter caps.
//
// Each tag carries the module id Vite will use for its own copy
// (`data-vite-dev-id`), under our own attribute name. `main.ts` hands the
// stylesheet over as soon as Vite injects that copy — see `adoptViteDevStyles`.
// We deliberately do NOT reuse `data-vite-dev-id` itself: Vite's client adopts
// any pre-existing link with that attribute and then skips `updateStyle` for
// it, which would leave CSS edits stranded.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pageModulePreloads } from "./client-manifest.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const STYLE_ATTRIBUTE = "data-dms-dev-style";
const SFC_STYLE = /[?&]vue&type=style/;
const STYLE_EXTENSION =
  /\.(?:css|less|pcss|postcss|sass|scss|styl|stylus)(?:$|\?)/;

/**
 * The workspace's generated entry stylesheet. `main.ts` is its only importer,
 * so it never enters the SSR module graph, yet it carries Tailwind, Nuxt UI and
 * one `@source` per materialized module — nearly every rule a page needs.
 * Naming it is the one enumeration this module accepts, and the comment is the
 * reason why.
 */
const ENTRY_STYLESHEET = "/dms-main.css";

function ssrModuleGraph(devServer) {
  return devServer.environments?.ssr?.moduleGraph ?? devServer.moduleGraph;
}

function directUrl(url) {
  return `${url}${url.includes("?") ? "&" : "?"}direct`;
}

function styleModules(devServer) {
  const graph = ssrModuleGraph(devServer);
  if (!graph) return [];
  return [...graph.urlToModuleMap.entries()]
    .filter(([url]) => SFC_STYLE.test(url) || STYLE_EXTENSION.test(url))
    .map(([url, module]) => ({ url, id: module?.id ?? url }));
}

function linkTag({ url, id }) {
  return `<link rel="stylesheet" ${STYLE_ATTRIBUTE}="${id}" href="${directUrl(url)}">`;
}

/**
 * A single-file component's `<style>` block is served with a JavaScript content
 * type even when requested directly, so a browser would refuse it as a
 * stylesheet. They are small; inline them instead. A block that could close its
 * own tag is dropped rather than escaped — CSS has no escape that is valid in
 * every position, and a scoped component rule is not worth the risk.
 */
async function inlineTag(devServer, { url, id }) {
  const result = await devServer
    .transformRequest(directUrl(url))
    .catch(() => undefined);
  const css = result?.code;
  if (!css || /<\/style/i.test(css)) return "";
  return `<style ${STYLE_ATTRIBUTE}="${id}">${css}</style>`;
}

/** Style tags for everything the development render touched, entry sheet first. */
export async function developmentStyleTags(devServer) {
  const modules = styleModules(devServer);
  const links = [
    { url: ENTRY_STYLESHEET, id: join(PROJECT_ROOT, "dms-main.css") },
    ...modules.filter(({ url }) => !SFC_STYLE.test(url)),
  ].map(linkTag);
  const inlined = await Promise.all(
    modules
      .filter(({ url }) => SFC_STYLE.test(url))
      .map((module) => inlineTag(devServer, module)),
  );
  return [...links, ...inlined].join("");
}

/**
 * The style tags a document needs, whichever server is answering it: collected
 * from the live module graph in development, read from the build manifest in
 * production.
 */
export async function documentStyleTags(devServer, page, template) {
  return devServer
    ? developmentStyleTags(devServer)
    : pageModulePreloads(page, template);
}
