import { Command, Option } from "commander";
import { Options } from "../config";
import { type HelpExample, withExamples } from "@antelopejs/core/cli";
import type { SnapshotOptions } from "./snapshot-action";

const SNAPSHOT_EXAMPLES: HelpExample[] = [
  {
    description: "With DMS_BOOTSTRAP_SECRET set, after a backend release",
    command: "ajs dms snapshot -b https://dms.example.com -o dms-snapshot",
  },
];

export function cmdSnapshot(): Command {
  const command = new Command("snapshot")
    .summary("Keep what a build needs from the backend, without its secrets")
    .description(
      "Fetch the manifest and the layers archive the backend serves, and write them into a directory with every private value emptied, so that ajs dms build --from builds without the backend or any credential. Take it again when the backend's frontend modules change: start says when they no longer match.",
    )
    .addOption(
      Options.backendUrl(
        "Backend URL to take the snapshot from; required, as -b or the variable",
      ),
    )
    .addOption(
      new Option(
        "-o, --output <dir>",
        "Directory to write the snapshot to",
      ).default("dms-snapshot"),
    )
    .addOption(Options.bootstrapSecret())
    .action(async (options: SnapshotOptions) =>
      (await import("./snapshot-action")).runSnapshot(options),
    );
  return withExamples(command, SNAPSHOT_EXAMPLES);
}
