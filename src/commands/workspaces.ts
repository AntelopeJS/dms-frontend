import { Command } from "commander";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { WorkspacesOptions } from "./workspaces-action";

const WORKSPACES_EXAMPLES: HelpExample[] = [
  {
    description: "On a terminal: an aligned table",
    command: "ajs dms workspaces",
  },
  {
    description: "In a script",
    command: "ajs dms workspaces --json",
  },
];

export function cmdWorkspaces(): Command {
  const command = new Command("workspaces")
    .summary("List generated workspaces")
    .description("List generated workspaces, with their size and last use.")
    .option("--json", "Print the list as one JSON document on stdout")
    .addHelpText(
      "after",
      `
Piped, it prints one tab-separated line per workspace, without a header:
id, backend URL, key type (url or project), project directory, size in bytes,
last use (ISO 8601) and workspace directory.`,
    )
    .action(async (options: WorkspacesOptions) =>
      (await import("./workspaces-action")).runWorkspaces(options),
    );
  return withExamples(command, WORKSPACES_EXAMPLES);
}
