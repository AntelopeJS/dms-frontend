import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { autoImportedGlobals } from "./auto-imported-globals";

const ROOT = resolve(__dirname, "..");
const MODULE = resolve(ROOT, "templates", "eslint-globals.mjs");
const FORMATTER = resolve(ROOT, "node_modules", ".bin", "oxfmt");

function moduleSource(globals: Record<string, string>): string {
  return [
    "/**",
    " * ESLint flat-config globals for every name the DMS renderer auto-imports",
    " * into a module's sources: Vue's preset, `frontend-module.ts` and Nuxt",
    " * UI's composables. Written by `pnpm eslint-globals`.",
    " */",
    `export default Object.freeze(${JSON.stringify(globals)});`,
    "",
  ].join("\n");
}

/** Writes `templates/eslint-globals.mjs` from the auto-importer's own list. */
async function main(): Promise<void> {
  writeFileSync(MODULE, moduleSource(await autoImportedGlobals()));
  execFileSync(FORMATTER, [MODULE], { stdio: "ignore" });
}

void main();
