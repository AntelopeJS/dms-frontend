import { Command } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "../help";
import type { StartOptions } from "./start-action";

const START_EXAMPLES: HelpExample[] = [
  {
    description: "After ajs dms build -b https://dms.example.com",
    command: "ajs dms start -b https://dms.example.com -p 3001",
  },
];

export function cmdStart(): Command {
  const command = new Command("start")
    .summary("Serve the production build")
    .description(
      "Serve the production frontend ajs dms build made for the same backend URL. Needs the DMS_SESSION_SECRET the build used.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL the build was made for; required, as -b or the variable",
      ),
    )
    .addOption(Options.port)
    .action(async (options: StartOptions) =>
      (await import("./start-action")).runStart(options),
    );
  return withExamples(command, START_EXAMPLES);
}
