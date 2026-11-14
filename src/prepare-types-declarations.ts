import { execFile } from "node:child_process";
import {
  existsSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, parse, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError, pluralize } from "@antelopejs/core/cli";
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
const COMPONENTS_SCRIPT = "./vue-components.mjs";
const DECLARATION_SUFFIX = ".d.ts";
const runFile = promisify(execFile);

/** The files under `directory`, none when it does not exist. */
function listFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * The absolute path of every `.vue` file the declarations config of
 * `workspace` includes, as TypeScript reads that config.
 */
async function listComponents(workspace: string): Promise<string[]> {
  const unlisted = (reason: string) =>
    new CliError({
      title: "The .vue files of the sources could not be listed",
      reason,
    });
  let stdout: string;
  try {
    ({ stdout } = await runFile(
      process.execPath,
      [COMPONENTS_SCRIPT, DECLARATIONS_CONFIG],
      { cwd: workspace },
    ));
  } catch (error) {
    throw unlisted(error instanceof Error ? error.message : String(error));
  }
  const files: unknown = JSON.parse(stdout);
  if (
    !Array.isArray(files) ||
    !files.every((file): file is string => typeof file === "string")
  )
    throw unlisted(`${COMPONENTS_SCRIPT} printed no list of paths.`);
  return files.map((file) => resolve(file));
}

/** Where `vue-tsc` writes the declaration of `component` under `emitted`. */
function declarationOf(emitted: string, component: string): string {
  return `${join(emitted, relative(parse(component).root, component))}${DECLARATION_SUFFIX}`;
}

/**
 * Deletes every emitted file that is not the declaration of a `.vue` file: the
 * `.ts` sources must keep resolving to themselves, not to a copy of them.
 */
function keepVueDeclarations(directory: string): void {
  for (const file of listFiles(directory))
    if (!isVueDeclaration(file)) rmSync(file, { force: true });
}

/**
 * Emits a declaration for each `.vue` file of the sources, under
 * `vue-declarations/` of `context.workspace`, with `vue-tsc`, so that the named
 * types a `.ts` file imports from a component resolve. The type check is
 * skipped: it is the module's own to run. `vue-tsc` exits with a diagnostic for
 * each declaration that names a private type and writes none for that file;
 * the run fails when any `.vue` file the config includes is left without a
 * declaration, and lists each of them. `vue-tsc` may write nothing outside
 * `context.workspace`: the declaration of a `.ts` file a component imports from
 * another drive than the sources is refused, not written beside that file.
 */
export async function emitVueDeclarations(
  context: VerificationContext,
  layers: ResolvedLayer[],
): Promise<void> {
  const workspace = realpathSync.native(context.workspace);
  const table = layerTable(workspace, layers);
  const config = join(workspace, DECLARATIONS_CONFIG);
  writeFileSync(
    config,
    `${JSON.stringify(
      vueDeclarationsConfig({
        layers: table,
        outDir: workspace,
      }),
      null,
      2,
    )}\n`,
  );
  const typecheckArguments = [
    "--import",
    "./workspace-writes.mjs",
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
      cwd: workspace,
      mapLine: context.mapLine,
    },
  );
  const emitted = join(workspace, VUE_DECLARATIONS_DIR);
  keepVueDeclarations(emitted);
  const components = await listComponents(workspace).finally(() =>
    rmSync(config, { force: true }),
  );
  const missing = components.filter(
    (component) => !existsSync(declarationOf(emitted, component)),
  );
  if (missing.length === 0) return;
  const failure = describeChildFailure({
    title: `No declaration was written for ${pluralize(missing.length, ".vue component")}`,
    command: "vue-tsc --noCheck",
    code: result.code,
    lines: result.lines,
    isVerbose: context.isVerbose,
  });
  throw new CliError({
    ...failure,
    reason: `vue-tsc --noCheck exited with code ${result.code} and wrote no declaration for these components.${context.isVerbose ? " Its output is above." : ""}`,
    details: [...missing, ...(failure.details ?? [])],
  });
}
