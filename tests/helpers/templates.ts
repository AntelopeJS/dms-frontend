import { cpSync, readFileSync } from "node:fs";
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
