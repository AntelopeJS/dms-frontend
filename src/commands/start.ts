import { Command } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { StartOptions } from "./start-action";

const START_EXAMPLES: HelpExample[] = [
  {
    description: "After ajs dms build -b https://dms.example.com",
    command: "ajs dms start -b https://dms.example.com -p 3001",
  },
  {
    description:
      "From a build shipped with the project, in a read-only container",
    command: "ajs dms start --workspace .dms-frontend -p 3000",
  },
];

export function cmdStart(): Command {
  const command = new Command("start")
    .summary("Serve the production build")
    .description(
      "Serve the production frontend ajs dms build made for the same backend URL, or the one in --workspace. Reads DMS_SESSION_SECRET and the server's secrets (DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET) from its environment, and says once ready whether the backend still serves the modules the build was made from.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL to serve; required, as -b or the variable, unless --workspace holds a build that records it",
      ),
    )
    .addOption(Options.port)
    .addOption(
      Options.workspace(
        "Serve the build in this directory (ajs dms build --workspace); start writes nothing into it",
      ),
    )
    .action(async (options: StartOptions) =>
      (await import("./start-action")).runStart(options),
    );
  return withExamples(command, START_EXAMPLES);
}
