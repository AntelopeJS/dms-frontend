import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import type { Command } from "commander";
import { cmdClean } from "../src/commands/clean";
import { runClean } from "../src/commands/clean-action";
import { cmdDev } from "../src/commands/dev";
import { formatEnvironmentHelp } from "../src/help";
import { problemText } from "./fixtures/memory-ui";

function fullHelp(command: Command): string {
  let text = "";
  command.configureOutput({
    getOutHelpWidth: () => 200,
    writeOut: (chunk) => {
      text += chunk;
    },
  });
  command.outputHelp();
  return text;
}

async function cleanUsageText(): Promise<string> {
  const error = await runClean({}).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  assert.ok(error instanceof CliError, "clean without -b or --all refuses");
  return problemText(error);
}

/** Help lines that tie build or start to the workspace dev -b keys on a URL. */
function linesSharingWithProduction(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=\.) |→|\$|#|:\s/)
    .filter((line) => /\bshare|\bdev -b\b/i.test(line))
    .filter((line) => /\b(build|start)\b/.test(line));
}

void describe("workspace help", () => {
  void it("never says build and start share the workspace dev -b uses", async () => {
    const surfaces = {
      "help environment": formatEnvironmentHelp(200),
      "clean --help": fullHelp(cmdClean()),
      "dev --help": fullHelp(cmdDev()),
      "clean without -b": await cleanUsageText(),
    };
    const claims = Object.fromEntries(
      Object.entries(surfaces).map(([surface, text]) => [
        surface,
        linesSharingWithProduction(text),
      ]),
    );
    assert.deepEqual(claims, {
      "help environment": [],
      "clean --help": [],
      "dev --help": [],
      "clean without -b": [],
    });
  });

  void it("says build and start use <project>/.dms-frontend or --workspace", () => {
    assert.match(
      formatEnvironmentHelp(200).replace(/\s+/g, " "),
      /build and start use <project>\/\.dms-frontend, or --workspace/,
    );
  });
});
