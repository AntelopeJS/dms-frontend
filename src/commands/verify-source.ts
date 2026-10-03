import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { Command } from "commander";
import { runCommand, UsageError } from "../common";
import {
  LAYER_PATH_FIX,
  reportVerification,
  type VerificationResult,
} from "../verify-source-result";

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
        throw new UsageError({
          title: `Invalid local package '${value}'`,
          fixes: [
            "Pass it as name=path: --local-package @scope/package=../package",
          ],
        });
      return [value.slice(0, separator), resolve(value.slice(separator + 1))];
    }),
  );
}

/**
 * Fail on a missing package root here: the runner would only find out after
 * creating its temporary workspace, and crash with a raw ENOENT stack.
 */
function assertDirectory(path: string, label: string): void {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) return;
  throw new UsageError({
    title: `${label} not found: ${path}`,
    fixes: [LAYER_PATH_FIX],
  });
}

/** The output flags the core reads from the command line, for the runner. */
const FORWARDED_FLAGS = ["--no-color", "--verbose"];

/** How long the result may take to arrive once the runner has exited. */
const RESULT_TIMEOUT_MS = 2000;

/** Resolves once the runner closed its IPC channel, or soon after it exited. */
function channelClosed(child: ChildProcess): Promise<void> {
  return new Promise((settle) => {
    child.once("disconnect", settle);
    child.once("exit", () => setTimeout(settle, RESULT_TIMEOUT_MS).unref());
  });
}

/**
 * The runner shows its checks as tasks while it works, then sends its result
 * here: the summary, or the failure the error boundary reports once.
 */
async function verifySource(options: VerifySourceOptions): Promise<void> {
  const startedAt = Date.now();
  assertDirectory(options.layer, "Layer path");
  for (const path of options.module) assertDirectory(path, "Module path");
  const localPackages = parseLocalPackages(options.localPackage);
  // Next to this module: the compiled runner, or its source under tsx.
  const runner = join(
    __dirname,
    "..",
    `verify-source-runner${extname(__filename)}`,
  );
  const flags = FORWARDED_FLAGS.filter((flag) => process.argv.includes(flag));
  let result: VerificationResult | undefined;
  let closed: Promise<void> = Promise.resolve();
  const code = await runCommand(
    process.execPath,
    [...process.execArgv, runner, ...flags],
    {
      shell: false,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        DMS_LAYER_SOURCE: resolve(options.layer),
        DMS_MODULE_SOURCES: JSON.stringify(
          options.module.map((path) => resolve(path)),
        ),
        DMS_LOCAL_PACKAGES: JSON.stringify(localPackages),
      },
    },
    (child) => {
      child.on("message", (message: VerificationResult) => {
        result = message;
      });
      closed = channelClosed(child);
    },
  );
  await closed;
  reportVerification(
    result ?? {
      ok: false,
      problem: {
        title: "Source verification failed",
        reason: `The verification exited with code ${code} before reporting a result; its output is above.`,
      },
    },
    Date.now() - startedAt,
  );
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
