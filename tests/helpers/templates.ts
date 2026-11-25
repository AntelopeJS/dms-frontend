import { cpSync, readFileSync } from "node:fs";
import { isJsonObject, type JsonValue } from "../../src/internal/json";
import { isScalar, isSeq, parseDocument } from "yaml";
import { join } from "node:path";
import { listNames } from "./files";

const TEMPLATE = "templates/vue";

/** Puts the email renderer's template files in a workspace, as the CLI does. */
export function copyEmailRendererFiles(workspace: string): void {
  for (const file of listNames(TEMPLATE).filter(
    (name) =>
      name.startsWith("email-") ||
      name === "public-options.ts" ||
      name === "message-subset.ts" ||
      name === "vite.email.config.ts",
  ))
    cpSync(join(TEMPLATE, file), join(workspace, file));
}

/** The pnpm settings of the generated workspace that a test reads. */
export interface WorkspacePnpmConfig {
  minimumReleaseAge: unknown;
  minimumReleaseAgeExclude: unknown;
}

/** The `pnpm-workspace.yaml` the generated dashboard workspace starts from, parsed. */
export function readWorkspacePnpmConfig(): WorkspacePnpmConfig {
  const document = parseDocument(
    readFileSync(join(TEMPLATE, "pnpm-workspace.yaml"), "utf8"),
  );
  const exclude = document.get("minimumReleaseAgeExclude", true);
  return {
    minimumReleaseAge: document.get("minimumReleaseAge"),
    minimumReleaseAgeExclude: isSeq(exclude)
      ? exclude.items.map((item) => (isScalar(item) ? item.value : item))
      : exclude,
  };
}

/** The `packageManager` the generated dashboard workspace pins. */
export function readWorkspacePackageManager(): string | undefined {
  const manifest = readFileSync(join(TEMPLATE, "package.json"), "utf8");
  return /"packageManager":\s*"([^"]+)"/.exec(manifest)?.[1];
}

/** The `compilerOptions` of the `tsconfig.workspace.json` the generated types workspace starts from. */
export function readWorkspaceCompilerOptions(): {
  [option: string]: JsonValue;
} {
  const config: unknown = JSON.parse(
    readFileSync(join(TEMPLATE, "tsconfig.workspace.json"), "utf8"),
  );
  const options = isJsonObject(config) ? config.compilerOptions : undefined;
  if (!isJsonObject(options))
    throw new Error("tsconfig.workspace.json holds no compilerOptions");
  return options;
}
