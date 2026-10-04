import { Command } from "commander";
import { type HelpExample, withExamples } from "../help";
import type { VerifySourceOptions } from "./verify-source-action";

/** Collects a repeatable option; no default, so the help shows none. */
function collectOption(value: string, values: string[] = []): string[] {
  return [...values, value];
}

const VERIFY_SOURCE_EXAMPLES: HelpExample[] = [
  {
    description: "A frontend package and a module that uses it",
    command: "ajs dms verify-source -l ../dms/frontend-vue -m ./frontend-vue",
  },
  {
    description: "With a local build of a package it depends on",
    command:
      "ajs dms verify-source -l . --local-package @antelopejs/dms=../dms",
  },
];

/** Creates the command that verifies unpublished frontend source packages. */
export function cmdVerifySource(): Command {
  const command = new Command("verify-source")
    .summary("Build and type-check unpublished frontend sources")
    .description(
      "Build and type-check unpublished DMS frontend sources against this loader version, in a temporary workspace removed when the run ends. Starts no backend.",
    )
    .requiredOption(
      "-l, --layer <path>",
      "Root of the DMS frontend package to verify (required)",
    )
    .option(
      "-m, --module <path>",
      "Root of another frontend package to verify with it (repeatable)",
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
