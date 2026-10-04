import { Command } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { PrepareOptions } from "./prepare-action";

const PREPARE_EXAMPLES: HelpExample[] = [
  {
    description: "From a frontend module's postinstall hook",
    command: "ajs dms prepare",
  },
  {
    description: "Before a CI type check, which needs the types",
    command: "ajs dms prepare -b http://localhost:5010 --strict",
  },
];

export function cmdPrepare(): Command {
  const command = new Command("prepare")
    .summary("Generate the workspace and module types (postinstall-safe)")
    .description(
      "Generate the workspace, the frontend-module registry and the module types. Without --strict, prepare never fails: when it cannot prepare the workspace it warns and exits 0, so a postinstall hook never breaks an install.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL; without one, prepare is skipped with a warning",
      ),
    )
    .addOption(Options.force("Reinstall the workspace dependencies"))
    .addOption(
      Options.offline("Reuse the last cached manifest instead of fetching it"),
    )
    .addOption(Options.strict)
    .addOption(
      Options.bootstrapSecret(
        "Discovered from .antelope/dms-dev.json for the enclosing project's backend",
      ),
    )
    .action(async (options: PrepareOptions) =>
      (await import("./prepare-action")).runPrepare(options),
    );
  return withExamples(command, PREPARE_EXAMPLES);
}
