import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const TESTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNIPPET_FILE = join(TESTS_DIR, "type-check-snippet.ts");

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2021,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  esModuleInterop: true,
  skipLibCheck: true,
  noEmit: true,
  types: ["node"],
};

const parsedFiles = new Map<string, ts.SourceFile>();

/**
 * A compiler host that parses each file once per test process and hands the
 * same source file to every later program, as TypeScript's language service
 * shares its document registry. `fresh` names the files a check writes for
 * itself, which are parsed again each time.
 */
function sharingHost(
  options: ts.CompilerOptions,
  fresh: (file: string) => boolean,
): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (file, languageVersion, onError) => {
    if (fresh(file)) return getSourceFile(file, languageVersion, onError);
    const key = `${file}\0${JSON.stringify(languageVersion)}`;
    const parsed =
      parsedFiles.get(key) ?? getSourceFile(file, languageVersion, onError);
    if (parsed) parsedFiles.set(key, parsed);
    return parsed;
  };
  return host;
}

/**
 * The compiler errors of `source` as `TS<code>: <message>` lines, compiled with
 * the repository's strict options as if it sat in `tests/`, so it can import
 * `../src/...`. An empty list means the snippet type-checks.
 */
export function typeErrors(source: string): string[] {
  const host = sharingHost(OPTIONS, (file) => file === SNIPPET_FILE);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (file) => (file === SNIPPET_FILE ? source : readFile(file));
  host.getSourceFile = (file, languageVersion, onError) =>
    file === SNIPPET_FILE
      ? ts.createSourceFile(file, source, languageVersion)
      : getSourceFile(file, languageVersion, onError);
  const program = ts.createProgram([SNIPPET_FILE], OPTIONS, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (diagnostic) =>
        `TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
    );
}

/**
 * The errors of the project `configFile` describes, checked as
 * `tsc --noEmit -p <configFile>` checks it, one `<file>(<line>,<column>):
 * error TS<code>: <message>` line per error, with the project's own files
 * parsed fresh. An empty list means the project type-checks; a broken config
 * or a syntax error may list other errors than tsc prints, never none.
 */
export function projectTypeErrors(configFile: string): string[] {
  const project = dirname(configFile);
  const config = ts.getParsedCommandLineOfConfigFile(configFile, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    },
  });
  if (!config) throw new Error(`${configFile} could not be read`);
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    projectReferences: config.projectReferences,
    configFileParsingDiagnostics: config.errors,
    host: sharingHost(config.options, (file) => file.startsWith(`${project}/`)),
  });
  const formatHost: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => project,
    getNewLine: () => "\n",
  };
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.formatDiagnostic(diagnostic, formatHost).trimEnd());
}
