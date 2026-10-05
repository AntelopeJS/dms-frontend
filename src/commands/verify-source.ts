import { Command } from "commander";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { VerifySourceOptions } from "./verify-source-action";

/** Collects a repeatable option; no default, so the help shows none. */
function collectOption(value: string, values: string[] = []): string[] {
  return [...values, value];
}

const VERIFY_SOURCE_EXAMPLES: HelpExample[] = [
  {
    description:
      "The project's frontend module: the current directory or ./frontend-vue",
    command: "ajs dms verify-source",
  },
  {
    description: "Frontend modules in other directories",
    command: "ajs dms verify-source -m ./admin-vue -m ./shop-vue",
  },
  {
    description:
      "An unpublished DMS core layer, with a local build of @antelopejs/dms",
    command: "ajs dms verify-source -l . --local-package @antelopejs/dms=..",
  },
];

/** Creates the command that verifies unpublished frontend source packages. */
export function cmdVerifySource(): Command {
  const command = new Command("verify-source")
    .summary("Build and type-check unpublished frontend sources")
    .description(
      "Build and type-check unpublished DMS frontend modules against this loader version, on top of the DMS core layer of the @antelopejs/dms installed in the project. Runs in a temporary workspace removed when the run ends, and starts no backend.",
    )
    // Checked by the action rather than by Commander, which would stop at
    // the first problem: the action reports every one of them at once.
    .option(
      "-l, --layer <path>",
      "Root of an unpublished DMS core layer to verify instead of the installed one",
    )
    .option(
      "-m, --module <path>",
      "Root of a frontend module to verify (repeatable); without -l or -m, the current directory or ./frontend-vue",
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
