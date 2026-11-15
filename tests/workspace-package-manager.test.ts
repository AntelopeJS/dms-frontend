import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import { runWorkspacePnpm } from "../src/child-command";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

/**
 * The lines `runWorkspacePnpm(["root"])` prints with `env` over the CLI's own,
 * through a `pnpm` on `PATH` that prints whether it sees `COREPACK_ROOT` and
 * the value of `KEPT`.
 */
async function pnpmOutput(env: NodeJS.ProcessEnv): Promise<string[]> {
  const bin = temporaryDirectory("workspace-path-pnpm-");
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\necho "corepack=${COREPACK_ROOT:-unset} kept=$KEPT"\n',
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  writeFileSync(
    join(bin, "pnpm.cmd"),
    "@if defined COREPACK_ROOT (echo corepack=%COREPACK_ROOT% kept=%KEPT%) else (echo corepack=unset kept=%KEPT%)\r\n",
  );
  const pathKey =
    Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  const { code, lines } = await runWorkspacePnpm(["root"], {
    name: "pnpm",
    cwd: bin,
    env: {
      ...process.env,
      [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ""}`,
      ...env,
    },
  });
  assert.equal(code, 0, lines.join("\n"));
  return lines;
}

void describe("pnpm in a generated workspace", () => {
  void it("runs without the COREPACK_ROOT of a project corepack runs, so pnpm switches to the version the workspace pins", async () => {
    assert.deepEqual(
      await pnpmOutput({ COREPACK_ROOT: "/corepack", KEPT: "yes" }),
      ["corepack=unset kept=yes"],
    );
  });
});
