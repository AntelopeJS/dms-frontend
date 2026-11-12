import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build, type Plugin } from "vite";
import { isObjectLike } from "../src/internal/guards";
import { autoImportSources } from "../templates/vue/auto-imports.mjs";

/** An ESLint flat-config `languageOptions.globals` object. */
export type EslintGlobals = Record<string, "readonly">;

const AUTO_IMPORTER = "unplugin-auto-import";
const FRONTEND_MODULE = "/workspace/frontend-module.ts";
const ENTRY = "dms-eslint-globals-entry";
const RESOLVED_ENTRY = `\0${ENTRY}`;
const READ_ATTEMPTS = 250;
const READ_INTERVAL_MS = 20;

function isGlobals(value: unknown): value is EslintGlobals {
  return (
    isObjectLike(value) &&
    Object.values(value).every((access) => access === "readonly")
  );
}

function parseGlobals(text: string): EslintGlobals | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isObjectLike(parsed) || !("globals" in parsed)) return undefined;
    return isGlobals(parsed.globals) ? parsed.globals : undefined;
  } catch {
    return undefined;
  }
}

async function autoImporter(globalsFile: string): Promise<Plugin> {
  const { default: ui } = await import("nuxt-ui-auto-imports/vite");
  const plugin = [
    ui({
      autoImport: {
        imports: autoImportSources(FRONTEND_MODULE),
        dts: false,
        eslintrc: {
          enabled: true,
          filepath: globalsFile,
          globalsPropValue: "readonly",
        },
      },
    }),
  ]
    .flat()
    .find((candidate) => candidate.name === AUTO_IMPORTER);
  if (!plugin) throw new Error(`@nuxt/ui no longer adds ${AUTO_IMPORTER}`);
  return plugin;
}

const emptyEntry: Plugin = {
  name: ENTRY,
  resolveId: (id) => (id === ENTRY ? RESOLVED_ENTRY : null),
  load: (id) => (id === RESOLVED_ENTRY ? "export {};" : null),
};

/**
 * The globals file, once written. The auto-importer starts its first write
 * from `buildStart` without awaiting it, and `buildEnd` skips a write whose
 * content matches: the file can still be on its way when the build returns.
 */
async function writtenGlobals(file: string): Promise<EslintGlobals> {
  for (let attempt = 0; attempt < READ_ATTEMPTS; attempt += 1) {
    const globals = await readFile(file, "utf8").then(parseGlobals, () =>
      parseGlobals(""),
    );
    if (globals) return globals;
    await delay(READ_INTERVAL_MS);
  }
  throw new Error(`${AUTO_IMPORTER} never wrote ${file}`);
}

/**
 * Every name the renderer's auto-importer gives a module's sources, as the
 * auto-importer itself lists them for ESLint: Nuxt UI's auto-importer run
 * with the workspace's `imports`, so Vue's preset, `frontend-module.ts` and
 * Nuxt UI's own composables. The modules' declared directories are left out:
 * each module owns those names.
 */
export async function autoImportedGlobals(): Promise<EslintGlobals> {
  const directory = await mkdtemp(join(tmpdir(), "dms-eslint-globals-"));
  try {
    const globalsFile = join(directory, "globals.json");
    await build({
      configFile: false,
      root: directory,
      logLevel: "silent",
      plugins: [emptyEntry, await autoImporter(globalsFile)],
      build: { write: false, rolldownOptions: { input: ENTRY } },
    });
    return await writtenGlobals(globalsFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
