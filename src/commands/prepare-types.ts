import { Command } from "commander";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { PrepareTypesOptions } from "./prepare-types-action";

/** Collects a repeatable option; no default, so the help shows none. */
function collectOption(value: string, values: string[] = []): string[] {
  return [...values, value];
}

const PREPARE_TYPES_EXAMPLES: HelpExample[] = [
  {
    description: "The types of the project's frontend module",
    command: "ajs dms prepare-types --out .dms-types",
  },
  {
    description: "The types of an unpublished DMS core layer",
    command:
      "ajs dms prepare-types -l . --out .dms-types --local-package @antelopejs/dms=..",
  },
];

/**
 * Creates the command that writes the type-check configuration of
 * unpublished frontend source packages.
 *
 * The options are checked by the action rather than by Commander, which
 * would stop at the first problem: the action reports every one of them at
 * once.
 */
export function cmdPrepareTypes(): Command {
  const command = new Command("prepare-types")
    .summary("Write the types of frontend sources for type-aware lint")
    .description(
      "Write a tsconfig.json and the auto-import declarations of DMS frontend modules to a directory that stays, with every path pointing at the module sources, for a module's tsconfig.json to extend. Starts no backend and builds no bundle.",
    )
    .requiredOption(
      "--out <dir>",
      "Directory to write; one this command wrote is emptied and written again, any other must be empty or new",
    )
    .option(
      "-l, --layer <path>",
      "Root of an unpublished DMS core layer instead of the installed one",
    )
    .option(
      "-m, --module <path>",
      "Root of a frontend module (repeatable); without -l or -m, the current directory or ./frontend-vue",
      collectOption,
    )
    .option(
      "--local-package <name=path>",
      "Bind a local package into the generated workspace (repeatable)",
      collectOption,
    )
    .action(async (options: PrepareTypesOptions) =>
      (await import("./prepare-types-action")).runPrepareTypes(options),
    );
  return withExamples(command, PREPARE_TYPES_EXAMPLES);
}
