import { Command } from "commander";
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
    .action(async (options: BuildOptions) =>
      (await import("./build-action")).runBuild(options),
    );
  return withExamples(command, BUILD_EXAMPLES);
}
