import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import type { ResolvedLayer } from "../src/common";
import { materializeWorkspace } from "../src/verify-source-workspace";
import { jsonAt, readJson } from "./helpers/json";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function directory(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

/** A pnpm lockfile whose `overrides:` section holds `lines`, as pnpm writes it. */
function lockfile(...lines: string[]): string {
  return [
    "lockfileVersion: '9.0'",
    "",
    "overrides:",
    ...lines.map((line) => `  ${line}`),
    "",
    "importers:",
    "",
    "  .: {}",
    "",
  ].join("\n");
}

const PROJECT = "project";
const MODULE = "project/frontend-vue";

/**
 * A frontend layer named `packageName` at `project/frontend-vue` in a
 * directory holding `files`, by path relative to that directory.
 */
function layer(
  packageName: string,
  files: Record<string, string> = {},
): ResolvedLayer {
  const root = directory("dms-layer-");
  const path = join(root, MODULE);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "dms.frontend.ts"), "export default {};\n");
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({ name: packageName, version: "1.0.0" }),
  );
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return { path, packageName };
}

/** The `pnpm.overrides` of the workspace verify-source installs. */
function workspaceOverrides(
  layers: ResolvedLayer[],
  localPackages: Record<string, string> = {},
) {
  const workspace = directory("dms-verify-workspace-");
  materializeWorkspace(workspace, layers, localPackages);
  return jsonAt(readJson(join(workspace, "package.json")), "pnpm", "overrides");
}

void describe("the workspace verify-source installs", () => {
  void it("carries the overrides the layer's lockfile records, resolving file: and link: paths from it", () => {
    const module = layer("demo-frontend-vue", {
      [`${MODULE}/pnpm-lock.yaml`]: lockfile(
        "'@antelopejs/interface-database': file:../.tgz-deps/antelopejs-interface-database-abc1234.tgz",
        "local-tool: link:../tools/local-tool",
        "'@antelopejs/dms>@antelopejs/interface-core': 0.4.0",
        "left-pad: 1.3.0",
        "is-odd: workspace:*",
      ),
    });
    assert.deepEqual(workspaceOverrides([module]), {
      "@antelopejs/interface-database": `file:${join(module.path, "..", ".tgz-deps", "antelopejs-interface-database-abc1234.tgz")}`,
      "local-tool": `link:${join(module.path, "..", "tools", "local-tool")}`,
      "@antelopejs/dms>@antelopejs/interface-core": "0.4.0",
      "left-pad": "1.3.0",
      "demo-frontend-vue": "workspace:*",
    });
  });

  void it("reads the lockfile of the workspace the layer belongs to, not the layer's own overrides or stale lockfile", () => {
    const module = layer("demo-frontend-vue", {
      [`${PROJECT}/pnpm-workspace.yaml`]: "packages:\n  - frontend-vue\n",
      [`${PROJECT}/pnpm-lock.yaml`]: lockfile(
        "is-number: 6.0.0",
        "is-odd: file:.tgz-deps/is-odd-abc1234.tgz",
      ),
      [`${MODULE}/package.json`]: JSON.stringify({
        name: "demo-frontend-vue",
        pnpm: { overrides: { "is-number": "7.0.0" } },
      }),
      [`${MODULE}/pnpm-lock.yaml`]: lockfile("is-number: 7.0.0"),
    });
    assert.deepEqual(workspaceOverrides([module]), {
      "is-number": "6.0.0",
      "is-odd": `file:${join(module.path, "..", ".tgz-deps", "is-odd-abc1234.tgz")}`,
      "demo-frontend-vue": "workspace:*",
    });
  });

  void it("reads the layer's own lockfile in a workspace that gives each project one", () => {
    const module = layer("demo-frontend-vue", {
      [`${PROJECT}/pnpm-workspace.yaml`]: "packages:\n  - frontend-vue\n",
      [`${PROJECT}/.npmrc`]: "shared-workspace-lockfile=false\n",
      [`${PROJECT}/pnpm-lock.yaml`]: lockfile("is-number: 6.0.0"),
      [`${MODULE}/pnpm-lock.yaml`]: lockfile(
        "is-odd: file:../.tgz-deps/is-odd-abc1234.tgz",
      ),
    });
    assert.deepEqual(workspaceOverrides([module]), {
      "is-odd": `file:${join(module.path, "..", ".tgz-deps", "is-odd-abc1234.tgz")}`,
      "demo-frontend-vue": "workspace:*",
    });
  });

  void it("carries no overrides for a layer whose workspace has no lockfile", () => {
    const module = layer("demo-frontend-vue", {
      [`${PROJECT}/pnpm-workspace.yaml`]: "packages:\n  - frontend-vue\n",
      "pnpm-lock.yaml": lockfile("is-number: 6.0.0"),
    });
    assert.deepEqual(workspaceOverrides([module]), {
      "demo-frontend-vue": "workspace:*",
    });
  });

  void it("reads every document of a lockfile pnpm splits in two", () => {
    const module = layer("demo-frontend-vue", {
      [`${MODULE}/pnpm-lock.yaml`]: [
        "lockfileVersion: '9.0'",
        "",
        "importers:",
        "",
        "  .: {}",
        "",
        "---",
        lockfile("is-number: 6.0.0"),
      ].join("\n"),
    });
    assert.deepEqual(workspaceOverrides([module]), {
      "is-number": "6.0.0",
      "demo-frontend-vue": "workspace:*",
    });
  });

  void it("stops on a lockfile that does not parse, naming it", () => {
    const module = layer("demo-frontend-vue", {
      [`${MODULE}/pnpm-lock.yaml`]: [
        "<<<<<<< HEAD",
        lockfile("is-number: 6.0.0"),
        "=======",
        lockfile("is-number: 7.0.0"),
        ">>>>>>> main",
      ].join("\n"),
    });
    assert.throws(
      () => workspaceOverrides([module]),
      (error) =>
        error instanceof CliError &&
        error.problem.title.endsWith(
          "frontend-vue/pnpm-lock.yaml is not a pnpm lockfile",
        ),
    );
  });

  void it("keeps the layers and --local-package links over the overrides a layer was installed with", () => {
    const local = directory("dms-local-");
    const module = layer("demo-frontend-vue", {
      [`${MODULE}/pnpm-lock.yaml`]: lockfile(
        "demo-frontend-vue: 2.0.0",
        "'@antelopejs/dms': 1.0.0",
      ),
    });
    assert.deepEqual(
      workspaceOverrides([module], { "@antelopejs/dms": local }),
      {
        "demo-frontend-vue": "workspace:*",
        "@antelopejs/dms": `link:${local}`,
      },
    );
  });
});
