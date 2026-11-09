import { Command, Option } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { BuildOptions } from "./build-action";

const BUILD_EXAMPLES: HelpExample[] = [
  {
    description:
      "From the project root, into .dms-frontend: no backend, no secret, no network",
    command: "ajs dms build",
  },
  {
    description: "With another environment's configuration, into a directory",
    command: "ajs dms build -e staging --workspace /srv/dms-frontend",
  },
  {
    description:
      "Set the workspace up and install it, then build it later as it is",
    command: "ajs dms build --setup-only && ajs dms build --prepared",
  },
];

export function cmdBuild(): Command {
  const command = new Command("build")
    .summary("Build the production frontend")
    .description(
      "Build the production frontend from the AntelopeJS project itself: its antelope.config.ts, evaluated for the environment, and the frontend of each installed module that declares one (dmsFrontend in its package.json). No backend is asked. The build holds no secret, and start computes the modules' options again from the deployment's variables.",
    )
    .addOption(Options.project)
    .addOption(Options.env)
    .addOption(
      Options.workspace(
        "Build into this directory instead of <project>/.dms-frontend",
      ),
    )
    .addOption(Options.force("Reinstall the workspace dependencies"))
    .addOption(
      new Option(
        "--setup-only",
        "Set the workspace up and install its dependencies, then stop before the bundles",
      ),
    )
    .addOption(
      new Option(
        "--no-install",
        "With --setup-only, write the workspace without installing its dependencies",
      ),
    )
    .addOption(
      new Option(
        "--prepared",
        "Build the workspace --setup-only set up, as it is, without setting it up again; exit 3 when it is not prepared",
      ).conflicts(["setupOnly", "force"]),
    )
    .action(async (options: BuildOptions) =>
      (await import("./build-action")).runBuild(options),
    );
  return withExamples(command, BUILD_EXAMPLES);
}
