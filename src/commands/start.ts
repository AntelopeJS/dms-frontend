import { Command } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { StartOptions } from "./start-action";

const START_EXAMPLES: HelpExample[] = [
  {
    description: "From the project root, after ajs dms build",
    command: "ajs dms start -b https://api.example.com -p 3001",
  },
  {
    description: "In a read-only container holding the project and its build",
    command: "ajs dms start --workspace .dms-frontend -p 3000",
  },
];

export function cmdStart(): Command {
  const command = new Command("start")
    .summary("Serve the production build")
    .description(
      "Serve the production frontend ajs dms build made from the project. The modules' public options are computed again from the project's configuration and the current environment variables, so a deployment's variables need no rebuild. Reads DMS_SESSION_SECRET and the server's secrets (DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET) from its environment, and tells the backend once ready which module versions it serves.",
    )
    .addOption(Options.backendUrl("Backend URL to serve; required"))
    .addOption(Options.port)
    .addOption(Options.project)
    .addOption(Options.env)
    .addOption(
      Options.workspace(
        "Serve the build in this directory instead of <project>/.dms-frontend; start writes nothing into it",
      ),
    )
    .action(async (options: StartOptions) =>
      (await import("./start-action")).runStart(options),
    );
  return withExamples(command, START_EXAMPLES);
}
