import { cpSync, readFileSync } from "node:fs";
import { parse } from "yaml";
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
  minimumReleaseAge?: number;
  minimumReleaseAgeExclude?: string[];
}

/** The `pnpm-workspace.yaml` the generated dashboard workspace starts from, parsed. */
export function readWorkspacePnpmConfig(): WorkspacePnpmConfig {
  // SAFETY: the shipped file is a YAML mapping.
  return parse(
    readFileSync(join(TEMPLATE, "pnpm-workspace.yaml"), "utf8"),
  ) as WorkspacePnpmConfig;
}
