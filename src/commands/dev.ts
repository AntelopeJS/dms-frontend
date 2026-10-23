import { Command, Option } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { DevOptions } from "./dev-action";

const DEV_EXAMPLES: HelpExample[] = [
  {
    description: "Inside a project started with ajs project dev",
    command: "ajs dms dev",
  },
  {
    description: "Share one workspace with build and start",
    command: "ajs dms dev -b http://localhost:5010 -p 3001",
  },
];

export function cmdDev(): Command {
  const command = new Command("dev")
    .summary("Run the dev server against a local backend, with hot reload")
    .description(
      "Run the dev server with hot reload. It reads the frontend modules from the AntelopeJS project as build does, each module's frontendModule called with dev: true, and serves them in place from their sources. The backend, on this machine, gives the secrets it holds and says when the module store changes its modules.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL; when omitted, discovered from the enclosing antelope project's .antelope/dev.json",
      ),
    )
    .addOption(
      new Option(
        "--project <dir>",
        "The AntelopeJS project the modules are read from (default: the discovered backend's, else the current directory)",
      ),
    )
    .addOption(
      new Option(
        "-e, --env <environment>",
        "The AntelopeJS environment the backend runs, as ajs project dev -e (default: the base configuration)",
      ).env("ANTELOPEJS_LAUNCH_ENV"),
    )
    .addOption(Options.port)
    .addOption(Options.force("Reinstall the workspace dependencies"))
    .addOption(
      Options.offline("Reuse the last cached manifest instead of fetching it"),
    )
    .addOption(
      Options.bootstrapSecret(
        "Discovered from .antelope/dms-dev.json for the project's own backend",
      ),
    )
    .action(async (options: DevOptions) =>
      (await import("./dev-action")).runDev(options),
    );
  return withExamples(command, DEV_EXAMPLES);
}
