import { execFile } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError, pluralize } from "@antelopejs/core/cli";
import { describeChildFailure } from "./child-output";
import { runFramedCommand } from "./common";
import type { ResolvedLayer } from "./common";
import {
  declarationsRoot,
  filesystemRoot,
  isVueDeclaration,
  layerTable,
  relativeImports,
  VUE_DECLARATIONS_DIR,
  vueDeclarationsConfig,
} from "./prepare-types-relocate";
import type { VerificationContext } from "./verify-source-build";

const DECLARATIONS_CONFIG = "tsconfig.vue-declarations.json";
const COMPONENTS_SCRIPT = "./vue-components.mjs";
const DECLARATION_SUFFIX = ".d.ts";
/** The extensions TypeScript tries after a module specifier, `.vue` among them. */
const MODULE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".d.ts",
  ".mts",
  ".cts",
  ".d.mts",
  ".d.cts",
  ".js",
  ".mjs",
  ".cjs",
  ".vue",
];

/**
 * Whether a module specifier resolved to `path` names a file or directory
 * that exists, so a specifier only a comment of a declaration holds, such as
 * an example in a prop's documentation, names nothing.
 */
function isModule(path: string): boolean {
  return (
    existsSync(path) ||
    MODULE_EXTENSIONS.some((extension) => existsSync(`${path}${extension}`))
  );
}
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

/** Where the declaration of `component` lies under `emitted`, laid out from `rootDir`. */
function declarationOf(
  emitted: string,
  rootDir: string,
  component: string,
): string {
  return `${join(emitted, relative(rootDir, component))}${DECLARATION_SUFFIX}`;
}

/**
 * Moves what `emitted` holds at `subtree` up to `emitted` itself, dropping the
 * rest, which holds nothing but the directories above it.
 */
function liftTree(emitted: string, subtree: string): void {
  if (subtree === "") return;
  const lifted = join(emitted, subtree);
  const holding = `${emitted}.lifted`;
  rmSync(holding, { recursive: true, force: true });
  if (existsSync(lifted)) renameSync(lifted, holding);
  rmSync(emitted, { recursive: true, force: true });
  if (existsSync(holding)) renameSync(holding, emitted);
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
 * declaration, and lists each of them. The tree is emitted from the
 * filesystem root, then lifted to the `declarationsRoot` of the sources, of
 * every file it holds a declaration for and of every file a `.vue`
 * declaration imports by relative path, and `writeTsconfig` writes the
 * tsconfig laid out from that directory. `vue-tsc` may write nothing outside
 * `context.workspace`: the declaration of a `.ts` file a component imports from
 * another drive than the sources is refused, not written beside that file.
 */
export async function emitVueDeclarations(
  context: VerificationContext,
  layers: ResolvedLayer[],
  writeTsconfig: (rootDir: string) => void,
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
  const fromRoot = filesystemRoot(table);
  const files = listFiles(emitted);
  const origin = (file: string) => join(fromRoot, relative(emitted, file));
  const rootDir = declarationsRoot([
    ...table.map(({ source }) => source),
    ...files.map((file) => dirname(origin(file))),
    ...files.filter(isVueDeclaration).flatMap((file) =>
      relativeImports(readFileSync(file, "utf8"))
        .map((specifier) => resolve(dirname(origin(file)), specifier))
        .filter(isModule)
        .map((target) => dirname(target)),
    ),
  ]);
  keepVueDeclarations(emitted);
  liftTree(emitted, relative(fromRoot, rootDir));
  writeTsconfig(rootDir);
  const components = await listComponents(workspace).finally(() =>
    rmSync(config, { force: true }),
  );
  const missing = components.filter(
    (component) => !existsSync(declarationOf(emitted, rootDir, component)),
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
