import { Command } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "../help";
import type { BuildOptions } from "./build-action";

const BUILD_EXAMPLES: HelpExample[] = [
  {
    description: "With DMS_SESSION_SECRET set in the environment or ./.env",
    command: "ajs dms build -b https://dms.example.com",
  },
  {
    description: "Rebuild from the cache while the backend is down",
    command: "ajs dms build -b https://dms.example.com --offline",
  },
];

export function cmdBuild(): Command {
  const command = new Command("build")
    .summary("Build the production frontend")
    .description(
      "Build the production frontend from the manifest and layers archive the backend serves, into the workspace's dist directory. Needs a DMS_SESSION_SECRET of 32 characters or more.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL to build for; required, as -b or the variable",
      ),
    )
    .addOption(
      Options.force(
        "Extract the layers archive from scratch and reinstall the workspace dependencies",
      ),
    )
    .addOption(
      Options.offline(
        "Build from the last cached manifest and layers archive, without the backend",
      ),
    )
    .addOption(Options.bootstrapSecret())
    .action(async (options: BuildOptions) =>
      (await import("./build-action")).runBuild(options),
    );
  return withExamples(command, BUILD_EXAMPLES);
}
