// Reading the built client manifest and turning the components a server render
// created into the stylesheet links its HTML needs.
//
// Lives apart from server.mjs so the file stays under the size the linter
// allows. Production-only: in dev, Vite serves these itself.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUILT_TEMPLATE_PATH = join(PROJECT_ROOT, "dist/client/index.html");
const CLIENT_MANIFEST_PATH = join(
  PROJECT_ROOT,
  "dist/client/.vite/manifest.json",
);
const SOURCE_TEMPLATE_PATH = join(PROJECT_ROOT, "index.html");

// Read once and kept: both files are build output and cannot change while the
// server is up.
let clientManifest;
let productionTemplate;

export function productionHtmlTemplate() {
  if (productionTemplate) return productionTemplate;
  const templatePath = existsSync(BUILT_TEMPLATE_PATH)
    ? BUILT_TEMPLATE_PATH
    : SOURCE_TEMPLATE_PATH;
  productionTemplate = readFileSync(templatePath, "utf8");
  return productionTemplate;
}

function productionClientManifest() {
  if (clientManifest) return clientManifest;
  if (!existsSync(CLIENT_MANIFEST_PATH)) return undefined;
  clientManifest = JSON.parse(readFileSync(CLIENT_MANIFEST_PATH, "utf8"));
  return clientManifest;
}

function collectManifestStyles(manifest, key, styles, visited) {
  if (visited.has(key)) return;
  visited.add(key);
  const entry = manifest[key];
  if (!entry) return;
  for (const file of entry.css ?? []) styles.add(file);
  for (const imported of entry.imports ?? [])
    collectManifestStyles(manifest, imported, styles, visited);
}

/**
 * The stylesheets the client build split out for the components a server
 * render created, each named by the module id `@vitejs/plugin-vue` records in
 * the render's `ssrContext.modules`. That id is the component's path from the
 * workspace root, the very key the client manifest gives a lazily loaded
 * component, so the lookup needs no guessing from names. A component bundled
 * into another chunk is no key of its own: its stylesheet comes with that
 * chunk's, reached through the `imports` of the component that loaded it.
 */
function renderedModuleStyles(modules = []) {
  const manifest = productionClientManifest();
  const styles = new Set();
  if (!manifest) return styles;
  const visited = new Set();
  for (const id of modules)
    collectManifestStyles(manifest, id, styles, visited);
  return styles;
}

/**
 * Links the stylesheets of every component the server rendered and the built
 * template does not link already, so that none of them waits for its chunk's
 * JavaScript to arrive: the HTML would otherwise paint unstyled and shift once
 * it does. A component the render did not reach gets no link.
 */
export function renderedModuleStyleTags(modules, template) {
  return [...renderedModuleStyles(modules)]
    .filter((file) => !template.includes(`href="/${file}"`))
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("");
}
