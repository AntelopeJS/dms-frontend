import { Command } from "commander";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { CleanOptions } from "./clean-action";

const CLEAN_EXAMPLES: HelpExample[] = [
  {
    description: "The workspace build, start and dev -b share for a backend",
    command: "ajs dms clean -b https://dms.example.com",
  },
  {
    description: "Every workspace, without asking (scripts, CI)",
    command: "ajs dms clean --all --yes",
  },
];

export function cmdClean(): Command {
  // -b is not the shared option: clean deletes, so its target is never taken
  // from DMS_API_BASE_URL, which a project's .env sets without the user
  // having it in mind.
  const command = new Command("clean")
    .summary("Remove generated workspaces")
    .description(
      "Remove generated workspaces: their node_modules, manifest cache, downloaded layers and build output.",
    )
    .option(
      "-b, --backend-url <url>",
      "Backend URL whose workspace to remove; DMS_API_BASE_URL is never read",
    )
    .option("-a, --all", "Remove every workspace, after a confirmation")
    .option("-y, --yes", "Skip the confirmation of --all")
    .action(async (options: CleanOptions) =>
      (await import("./clean-action")).runClean(options),
    );
  return withExamples(command, CLEAN_EXAMPLES);
}
