import { cpSync } from "node:fs";
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
