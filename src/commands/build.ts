import { Command, Option } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { BuildOptions } from "./build-action";

const BUILD_EXAMPLES: HelpExample[] = [
  {
    description: "With DMS_BOOTSTRAP_SECRET set in the environment or ./.env",
    command: "ajs dms build -b https://dms.example.com",
  },
  {
    description:
      "From a snapshot, without the backend or any secret, into the project (a container image)",
    command: "ajs dms build --from dms-snapshot --workspace .dms-frontend",
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
      "Build the production frontend from the manifest and layers archive the backend serves, or from a snapshot of them, into the workspace's dist directory. The build holds no secret: the server reads its own from its environment when it starts.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL to build for; required, as -b or the variable, unless --from names a snapshot",
      ),
    )
    .addOption(
      new Option(
        "--from <dir>",
        "Build from the snapshot in this directory (ajs dms snapshot), without the backend",
      ),
    )
    .addOption(
      Options.workspace(
        "Build into this directory instead of the workspace under ~/.antelopejs, to ship it with the project",
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
