import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import { describeChildFailure } from "./child-output";
import { runFramedCommand } from "./common";
import type { ResolvedLayer } from "./common";
import {
  isVueDeclaration,
  layerTable,
  VUE_DECLARATIONS_DIR,
  vueDeclarationsConfig,
} from "./prepare-types-relocate";
import type { VerificationContext } from "./verify-source-build";

const DECLARATIONS_CONFIG = "tsconfig.vue-declarations.json";
const VUE_FILE_SUFFIX = ".vue";
const SKIPPED_DIRECTORY = "node_modules";

/** The files under `directory`, none when it does not exist. */
function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Whether a `.vue` file lies under `directory`, outside any `node_modules`. */
function holdsVueFile(directory: string): boolean {
  return readdirSync(directory, { withFileTypes: true }).some((entry) =>
    entry.isDirectory()
      ? entry.name !== SKIPPED_DIRECTORY &&
        holdsVueFile(join(directory, entry.name))
      : entry.name.endsWith(VUE_FILE_SUFFIX),
  );
}

/**
 * Deletes every emitted file that is not the declaration of a `.vue` file: the
 * `.ts` sources must keep resolving to themselves, not to a copy of them.
 * Returns how many declarations are left.
 */
function keepVueDeclarations(directory: string): number {
  const files = listFiles(directory);
  for (const file of files)
    if (!isVueDeclaration(file)) rmSync(file, { force: true });
  return files.filter(isVueDeclaration).length;
}

/**
 * Emits a declaration for each `.vue` file of the sources, under
 * `vue-declarations/` of `context.workspace`, with `vue-tsc`, so that the named
 * types a `.ts` file imports from a component resolve. The type check is
 * skipped: it is the module's own to run. `vue-tsc` exits with a diagnostic for
 * each declaration that names a private type and writes none for that file,
 * which keeps its shim; the run fails only when it writes no declaration at all
 * for sources that hold `.vue` files.
 */
export async function emitVueDeclarations(
  context: VerificationContext,
  layers: ResolvedLayer[],
): Promise<void> {
  const table = layerTable(context.workspace, layers);
  const config = join(context.workspace, DECLARATIONS_CONFIG);
  writeFileSync(
    config,
    `${JSON.stringify(
      vueDeclarationsConfig({
        layers: table,
        outDir: context.workspace,
      }),
      null,
      2,
    )}\n`,
  );
  const typecheckArguments = [
    "--import",
    "./typecheck-loader.mjs",
    "./node_modules/vue-tsc/bin/vue-tsc.js",
    "--project",
    DECLARATIONS_CONFIG,
    "--noCheck",
  ];
  const isWindows = process.platform === "win32";
  const result = await runFramedCommand(
    isWindows ? process.execPath : "env",
    isWindows
      ? typecheckArguments
      : ["-u", "NODE_OPTIONS", process.execPath, ...typecheckArguments],
    {
      name: "vue-tsc",
      cwd: context.workspace,
      mapLine: context.mapLine,
    },
  );
  rmSync(config, { force: true });
  const emitted = join(context.workspace, VUE_DECLARATIONS_DIR);
  const written = keepVueDeclarations(emitted);
  if (written > 0 || !table.some(({ source }) => holdsVueFile(source))) return;
  throw new CliError(
    describeChildFailure({
      title: "No declaration was written for the .vue files",
      command: "vue-tsc --noCheck",
      code: result.code,
      lines: result.lines,
      isVerbose: context.isVerbose,
    }),
  );
}
