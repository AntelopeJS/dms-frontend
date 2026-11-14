/**
 * Prints, as a JSON array, the absolute path of every `.vue` file the tsconfig
 * named by the first argument includes, its excludes applied the way
 * TypeScript applies them.
 *
 * @packageDocumentation
 */
import ts from "typescript";

const VUE_EXTENSION = {
  extension: ".vue",
  isMixedContent: true,
  scriptKind: ts.ScriptKind.Deferred,
};

const config = ts.getParsedCommandLineOfConfigFile(
  process.argv[2] ?? "",
  undefined,
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      );
    },
  },
  undefined,
  undefined,
  [VUE_EXTENSION],
);
process.stdout.write(
  JSON.stringify(
    (config?.fileNames ?? []).filter((file) => file.endsWith(".vue")),
  ),
);
