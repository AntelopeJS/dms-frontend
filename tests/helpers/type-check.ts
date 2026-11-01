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

/**
 * The compiler errors of `source` as `TS<code>: <message>` lines, compiled with
 * the repository's strict options as if it sat in `tests/`, so it can import
 * `../src/...`. An empty list means the snippet type-checks.
 */
export function typeErrors(source: string): string[] {
  const host = ts.createCompilerHost(OPTIONS);
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
