import { Command } from "commander";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { VerifySourceOptions } from "./verify-source-action";

/** Collects a repeatable option; no default, so the help shows none. */
function collectOption(value: string, values: string[] = []): string[] {
  return [...values, value];
}

const VERIFY_SOURCE_EXAMPLES: HelpExample[] = [
  {
    description: "A frontend module, on the installed DMS core layer",
    command:
      "ajs dms verify-source -l node_modules/@antelopejs/dms/frontend-vue -m .",
  },
  {
    description:
      "The DMS core layer itself, with a local build of @antelopejs/dms",
    command: "ajs dms verify-source -l . --local-package @antelopejs/dms=..",
  },
];

/** Creates the command that verifies unpublished frontend source packages. */
export function cmdVerifySource(): Command {
  const command = new Command("verify-source")
    .summary("Build and type-check unpublished frontend sources")
    .description(
      "Build and type-check unpublished DMS frontend sources against this loader version: the DMS core layer (the frontend-vue directory of @antelopejs/dms), and the frontend modules to verify on top of it. Runs in a temporary workspace removed when the run ends, and starts no backend.",
    )
    // Checked by the action rather than by Commander, which would stop at
    // the first problem: the action reports every one of them at once.
    .option(
      "-l, --layer <path>",
      "Root of the DMS core layer, the frontend-vue directory of @antelopejs/dms (required)",
    )
    .option(
      "-m, --module <path>",
      "Root of a frontend module to verify on top of it (repeatable)",
      collectOption,
    )
    .option(
      "--local-package <name=path>",
      "Bind a local package into the generated workspace (repeatable)",
      collectOption,
    )
    .action(async (options: VerifySourceOptions) =>
      (await import("./verify-source-action")).runVerifySource(options),
    );
  return withExamples(command, VERIFY_SOURCE_EXAMPLES);
}
