// Reading the built client manifest and turning a rendered page into the style
// and module-preload tags its HTML needs.
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

export function normalizeDmsName(name) {
  return name
    .replace(/^lazy/i, "")
    .replace(/^dms[-_]?/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export function collectRenderedComponentNames(value, names) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      collectRenderedComponentNames(entry, names);
    });
    return;
  }
  if (typeof value.componentName === "string")
    names.add(normalizeDmsName(value.componentName));
  Object.values(value).forEach((entry) => {
    collectRenderedComponentNames(entry, names);
  });
}

function productionClientManifest() {
  if (clientManifest) return clientManifest;
  if (!existsSync(CLIENT_MANIFEST_PATH)) return undefined;
  clientManifest = JSON.parse(readFileSync(CLIENT_MANIFEST_PATH, "utf8"));
  return clientManifest;
}

function sourceComponentName(source) {
  const filename =
    source
      .split("/")
      .at(-1)
      ?.replace(/\.vue$/, "") ?? "";
  return normalizeDmsName(filename);
}

function matchedPageManifestEntries(page, manifest) {
  const names = new Set();
  const layout = page.props?.page?.layout;
  collectRenderedComponentNames(layout, names);
  [
    page.props?.page?.componentName,
    layout?.componentName,
    layout?.layout?.componentName,
  ].forEach((name) => {
    if (typeof name === "string") names.add(normalizeDmsName(name));
  });
  return Object.entries(manifest)
    .filter(
      ([source, entry]) =>
        entry.isDynamicEntry && names.has(sourceComponentName(source)),
    )
    .map(([key]) => key);
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

export function pageModuleStyles(page) {
  const manifest = productionClientManifest();
  const styles = new Set();
  if (!manifest) return styles;
  const visited = new Set();
  for (const key of matchedPageManifestEntries(page, manifest))
    collectManifestStyles(manifest, key, styles, visited);
  return styles;
}

export function pageModulePreloads(page, template) {
  return [...pageModuleStyles(page)]
    .filter((file) => !template.includes(`href="/${file}"`))
    .map((file) => `<link rel="stylesheet" href="/${file}">`)
    .join("");
}
