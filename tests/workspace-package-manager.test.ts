import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, it } from "node:test";
import {
  copyStaticTemplates,
  writeWorkspacePackageJson,
} from "../src/materialize";
import { runWorkspacePnpm } from "../src/child-command";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

void describe("the generated workspace", () => {
  void it("runs under corepack with the pnpm of a project that pins another pnpm", () => {
    const project = temporaryDirectory("workspace-package-manager-");
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "app", private: true, packageManager: "pnpm@10.2.0" })}\n`,
    );
    const workspace = join(project, ".dms-types");
    mkdirSync(workspace);
    copyStaticTemplates(workspace);
    writeWorkspacePackageJson(workspace, []);
    const result = spawnSync("pnpm", ["root"], {
      cwd: workspace,
      encoding: "utf8",
      env: { ...process.env, COREPACK_ROOT: project },
      shell: process.platform === "win32",
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });

  void it("runs the pnpm that started the CLI under corepack, not another pnpm on PATH", async () => {
    const caller = join(
      temporaryDirectory("workspace-caller-pnpm-"),
      "pnpm.cjs",
    );
    writeFileSync(
      caller,
      "console.log(`caller strict=${process.env.COREPACK_ENABLE_STRICT}`);\n",
    );
    assert.deepEqual(
      await pnpmOutput({ npm_execpath: caller, COREPACK_ROOT: caller }),
      ["caller strict=0"],
    );
  });

  void it("runs the pnpm on PATH, such as corepack's shim, with corepack's strict check off when npm started the CLI", async () => {
    assert.deepEqual(
      await pnpmOutput({ npm_execpath: join("npm", "bin", "npm-cli.js") }),
      ["path strict=0"],
    );
  });
});

/**
 * The lines `runWorkspacePnpm(["root"])` prints with `env` over the CLI's own,
 * a `pnpm` on `PATH` printing `path strict=<COREPACK_ENABLE_STRICT>`.
 */
async function pnpmOutput(env: NodeJS.ProcessEnv): Promise<string[]> {
  const bin = temporaryDirectory("workspace-path-pnpm-");
  writeFileSync(
    join(bin, "pnpm"),
    '#!/bin/sh\necho "path strict=$COREPACK_ENABLE_STRICT"\n',
  );
  chmodSync(join(bin, "pnpm"), 0o755);
  writeFileSync(
    join(bin, "pnpm.cmd"),
    "@echo path strict=%COREPACK_ENABLE_STRICT%\r\n",
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
