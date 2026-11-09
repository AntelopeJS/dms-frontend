import ts from "typescript";

const FAILURE_EXIT_CODE = 1;

const FORMAT_HOST: ts.FormatDiagnosticsHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: () => process.cwd(),
  getNewLine: () => "\n",
};

/**
 * The project `configFile` describes, as a standalone program that emits
 * nothing. `composite` is dropped: it only serves the project reference that
 * lets the lint read `tsconfig.templates.json`, and its rule that every
 * imported file be listed belongs to a `tsc -b` build, which never runs here.
 */
function readProject(configFile: string): ts.ParsedCommandLine {
  const config = ts.getParsedCommandLineOfConfigFile(
    configFile,
    { noEmit: true, composite: false },
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(
          ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        );
      },
    },
  );
  if (!config) throw new Error(`${configFile} could not be read`);
  return config;
}

/**
 * The errors `tsc --noEmit -p <configFile>` reports, except those in a source
 * file the project only reaches through an import, which is left to the
 * project that lists it: the consumer-compiled template `.ts` files resolve
 * against the generated workspace, so `test:real-source` checks them there.
 * The errors of the project's own files and of its tsconfig chain are kept.
 */
function ownFileErrors(configFile: string): readonly ts.Diagnostic[] {
  const config = readProject(configFile);
  const ownFiles = new Set(
    config.fileNames.map((file) => ts.sys.resolvePath(file)),
  );
  const program = ts.createProgram({
    rootNames: config.fileNames,
    options: config.options,
    projectReferences: config.projectReferences,
    configFileParsingDiagnostics: config.errors,
  });
  const importedFiles = new Set(
    program
      .getSourceFiles()
      .map((file) => ts.sys.resolvePath(file.fileName))
      .filter((file) => !ownFiles.has(file)),
  );
  return ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) =>
        diagnostic.file === undefined ||
        !importedFiles.has(ts.sys.resolvePath(diagnostic.file.fileName)),
    );
}

function main(configFiles: readonly string[]): void {
  const errors = configFiles.flatMap(ownFileErrors);
  if (errors.length === 0) return;
  process.stderr.write(ts.formatDiagnostics(errors, FORMAT_HOST));
  process.exitCode = FAILURE_EXIT_CODE;
}

main(process.argv.slice(2));
