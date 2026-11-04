import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/** Where the client build writes the attribution, under `dist/client`. */
export const ENTRY_WEIGHT_FILE = ".vite/entry-weight.json";

/** Owners of the entry's bytes that are no frontend module. */
export const SHARED_OWNER = "shared";
export const TRANSLATIONS_OWNER = "translations";

const LOCALE_CATALOG = /[\\/]locales\.generated[\\/]/;

/**
 * @param {string} id
 * @returns {string}
 */
function stripQuery(id) {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
}

/**
 * @param {string} root
 * @param {string} file
 * @returns {boolean}
 */
function isInside(root, file) {
  const path = relative(root, file);
  return Boolean(path) && !path.startsWith("..") && !path.startsWith(sep);
}

/**
 * The owner of a module id of the bundle: the frontend module whose sources
 * hold the file, by its manifest name; the merged translation catalogs; else
 * what every page shares (the renderer's runtime, the UI and icon libraries,
 * an installed package).
 *
 * @param {string} id
 * @param {{ root: string, name?: string, packageName?: string, id: string }[]} modules
 * @returns {string}
 */
export function entryOwner(id, modules) {
  if (id.startsWith("\0")) return SHARED_OWNER;
  const file = stripQuery(id);
  if (/[\\/]node_modules[\\/]/.test(file)) return SHARED_OWNER;
  if (LOCALE_CATALOG.test(file)) return TRANSLATIONS_OWNER;
  const module = modules.find(({ root }) => isInside(root, file));
  return module
    ? (module.name ?? module.packageName ?? module.id)
    : SHARED_OWNER;
}

/**
 * The files a page loads before its first line runs: the entry chunks and
 * their static imports, transitively, by file name.
 *
 * @param {import("vite").Rollup.OutputBundle} bundle
 * @returns {(import("vite").Rollup.OutputChunk | undefined)[]}
 */
function entryClosure(bundle) {
  const chunks = Object.values(bundle).filter(
    (output) => output.type === "chunk",
  );
  const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {import("vite").Rollup.OutputChunk | undefined} chunk */
  const visit = (chunk) => {
    if (!chunk || seen.has(chunk.fileName)) return;
    seen.add(chunk.fileName);
    for (const file of chunk.imports ?? []) visit(byName.get(file));
  };
  for (const chunk of chunks) if (chunk.isEntry) visit(chunk);
  return [...seen].map((file) => byName.get(file));
}

/**
 * The bytes of the entry each owner accounts for. Each chunk's bytes are
 * shared out among the modules it holds in proportion to the code Rolldown
 * rendered for each (`renderedLength`, before minification): an estimate that
 * needs nothing the bundle does not already hold.
 *
 * @param {import("vite").Rollup.OutputBundle} bundle
 * @param {{ root: string, name?: string, packageName?: string, id: string }[]} modules
 * @returns {{ files: string[], bytes: number, owners: Record<string, number> }}
 */
export function attributeEntry(bundle, modules) {
  const files = entryClosure(bundle);
  /** @type {Record<string, number>} */
  const owners = {};
  let bytes = 0;
  for (const chunk of files) {
    const size = Buffer.byteLength(chunk.code);
    bytes += size;
    const rendered = Object.entries(chunk.modules ?? {});
    const total = rendered.reduce(
      (sum, [, info]) => sum + info.renderedLength,
      0,
    );
    if (!total) {
      owners[SHARED_OWNER] = (owners[SHARED_OWNER] ?? 0) + size;
      continue;
    }
    for (const [id, info] of rendered) {
      const owner = entryOwner(id, modules);
      owners[owner] =
        (owners[owner] ?? 0) + (size * info.renderedLength) / total;
    }
  }
  for (const owner of Object.keys(owners))
    owners[owner] = Math.round(owners[owner]);
  return { files: files.map((chunk) => chunk.fileName), bytes, owners };
}

/**
 * Records, in the client build, what each frontend module adds to the entry
 * (`ENTRY_WEIGHT_FILE`). Server builds are left alone: their bundle is no
 * page's entry.
 *
 * What each frontend module adds to the client entry. Every page loads the
 * entry, and everything it imports statically, before it runs anything: a
 * module's `dms.frontend.ts`, its plugins and whatever they import land there,
 * on every page of every application that loads the module. The client build
 * records, from the bundle's own metadata, how much of the entry each module's
 * sources make up; `ajs dms build` reports it and warns about a module above
 * its threshold. Kept beside vite.config.ts rather than inside it so the plugin
 * can be exercised on its own, the way client-chunking.mjs is.
 *
 * The weight is recorded once the bundle is written: plugins that generate the
 * bundle after this one still rewrite the chunks' code.
 *
 * @param {{ root: string, name?: string, packageName?: string, id: string }[]} modules
 * @returns {import("vite").Plugin}
 */
export function recordEntryWeight(modules) {
  let ssrBuild = false;
  return {
    name: "dms-entry-weight",
    configResolved(config) {
      ssrBuild = Boolean(config.build.ssr);
    },
    writeBundle(options, bundle) {
      if (ssrBuild || !options.dir) return;
      const file = join(options.dir, ENTRY_WEIGHT_FILE);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        `${JSON.stringify(attributeEntry(bundle, modules), null, 2)}\n`,
      );
    },
  };
}
