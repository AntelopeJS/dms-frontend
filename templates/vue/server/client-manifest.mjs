import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isNonNullObject, isString } from "./type-guards.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUILT_TEMPLATE_PATH = join(PROJECT_ROOT, "dist/client/index.html");
const CLIENT_MANIFEST_PATH = join(
  PROJECT_ROOT,
  "dist/client/.vite/manifest.json",
);
const SOURCE_TEMPLATE_PATH = join(PROJECT_ROOT, "index.html");

/**
 * A chunk of the client build, as far as the server reads it: its file, the
 * stylesheets it brings and the chunks it imports.
 *
 * @typedef {{
 *   file?: string,
 *   css?: string[] | null,
 *   imports?: string[] | null
 * }} ManifestEntry
 */

/**
 * Read once and kept: both files are build output and cannot change while
 * the server is up.
 *
 * @type {Record<string, ManifestEntry> | undefined}
 */
let clientManifest;
/** @type {string | undefined} */
let productionTemplate;

/**
 * Reads the built client manifest and turns the components a server render
 * created into the stylesheet links its HTML needs. Production-only: in dev,
 * Vite serves these itself.
 */
export function productionHtmlTemplate() {
  if (productionTemplate) return productionTemplate;
  const templatePath = existsSync(BUILT_TEMPLATE_PATH)
    ? BUILT_TEMPLATE_PATH
    : SOURCE_TEMPLATE_PATH;
  productionTemplate = readFileSync(templatePath, "utf8");
  return productionTemplate;
}

/**
 * @param {unknown} value
 * @returns {value is string[]}
 */
function isStringArray(value) {
  return Array.isArray(value) && value.every(isString);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return isNonNullObject(value);
}

/**
 * Whether `value` is a chunk whose `file`, `css` and `imports`, when it has
 * them, are what the server reads them as.
 *
 * @param {unknown} value
 * @returns {value is ManifestEntry}
 */
function isManifestEntry(value) {
  return (
    isRecord(value) &&
    (value.file === undefined || isString(value.file)) &&
    (value.css === undefined ||
      value.css === null ||
      isStringArray(value.css)) &&
    (value.imports === undefined ||
      value.imports === null ||
      isStringArray(value.imports))
  );
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, ManifestEntry>}
 */
function isClientManifest(value) {
  return isNonNullObject(value) && Object.values(value).every(isManifestEntry);
}

/** @returns {Record<string, ManifestEntry> | undefined} */
function productionClientManifest() {
  if (clientManifest) return clientManifest;
  if (!existsSync(CLIENT_MANIFEST_PATH)) return undefined;
  /** @type {unknown} */
  const manifest = JSON.parse(readFileSync(CLIENT_MANIFEST_PATH, "utf8"));
  if (!isClientManifest(manifest)) return undefined;
  clientManifest = manifest;
  return clientManifest;
}

/**
 * @param {Record<string, ManifestEntry>} manifest
 * @param {string} key
 * @param {Set<string>} styles
 * @param {Set<string>} visited
 */
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
 *
 * @param {Iterable<string>} [modules]
 * @returns {Set<string>}
 */
function renderedModuleStyles(modules = []) {
  const manifest = productionClientManifest();
  /** @type {Set<string>} */
  const styles = new Set();
  if (!manifest) return styles;
  /** @type {Set<string>} */
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
 *
 * @param {Iterable<string> | undefined} modules
 * @param {string} template
 */
export function renderedModuleStyleTags(modules, template) {
  return [...renderedModuleStyles(modules)]
    .filter((file) => !template.includes(`href="/${file}"`))
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("");
}

/**
 * The link that preloads the built catalog of `locale`, the one the page was
 * rendered with: the browser fetches it next to the entry rather than once the
 * entry runs and asks for it, which would put a round trip before hydration.
 * Nothing without a production build (Vite serves the sources in development).
 *
 * @param {string | undefined} locale
 */
export function localeCatalogPreloadTag(locale) {
  const manifest = productionClientManifest();
  const file = locale && manifest?.[`locales.generated/${locale}.ts`]?.file;
  return file ? `<link rel="modulepreload" crossorigin href="/${file}">` : "";
}
