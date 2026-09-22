import { join, resolve } from "node:path";
import { Command } from "commander";
import { getPackageRoot, runCommand } from "../common";

interface VerifySourceOptions {
  layer: string;
  localPackage: string[];
  module: string[];
}

function collectOption(value: string, values: string[]): string[] {
  return [...values, value];
}

export function parseLocalPackages(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || separator === value.length - 1)
        throw new Error(`Invalid local package "${value}"; expected name=path`);
      return [value.slice(0, separator), resolve(value.slice(separator + 1))];
    }),
  );
}

async function verifySource(options: VerifySourceOptions): Promise<void> {
  const runner = join(getPackageRoot(), "dist", "verify-source-runner.js");
  const code = await runCommand(process.execPath, [runner], {
    env: {
      ...process.env,
      DMS_LAYER_SOURCE: resolve(options.layer),
      DMS_MODULE_SOURCES: JSON.stringify(
        options.module.map((path) => resolve(path)),
      ),
      DMS_LOCAL_PACKAGES: JSON.stringify(
        parseLocalPackages(options.localPackage),
      ),
    },
  });
  if (code !== 0) throw new Error("Source verification failed");
}

/** Creates the command that verifies unpublished frontend source packages. */
export function cmdVerifySource(): Command {
  return new Command("verify-source")
    .description("Build and typecheck unpublished DMS frontend sources")
    .requiredOption("-l, --layer <path>", "DMS frontend package root")
    .option(
      "-m, --module <path>",
      "Additional frontend package root (repeatable)",
      collectOption,
      [],
    )
    .option(
      "--local-package <name=path>",
      "Bind a local package into the generated workspace (repeatable)",
      collectOption,
      [],
    )
    .action(verifySource);
}
