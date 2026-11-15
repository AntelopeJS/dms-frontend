import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  copyStaticTemplates,
  writeWorkspacePackageJson,
} from "../src/materialize";
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
});
