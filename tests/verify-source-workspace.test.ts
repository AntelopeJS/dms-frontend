import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
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

/** A frontend layer named `packageName` with its own `pnpm.overrides`. */
function layer(
  packageName: string,
  overrides: Record<string, string>,
  dependencies: Record<string, string> = {},
): ResolvedLayer {
  const root = directory("dms-layer-");
  const path = join(root, "frontend-vue");
  mkdirSync(path);
  writeFileSync(
    join(path, "package.json"),
    JSON.stringify({
      name: packageName,
      version: "1.0.0",
      dependencies,
      pnpm: { overrides },
    }),
  );
  writeFileSync(join(path, "dms.frontend.ts"), "export default {};\n");
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

describe("the workspace verify-source installs", () => {
  it("carries a layer's pnpm.overrides, resolving file: and link: paths from the layer", () => {
    const module = layer("demo-frontend-vue", {
      "@antelopejs/interface-database":
        "file:../.tgz-deps/antelopejs-interface-database-abc1234.tgz",
      "local-tool": "link:../tools/local-tool",
      "left-pad": "1.3.0",
    });
    assert.deepEqual(workspaceOverrides([module]), {
      "@antelopejs/interface-database": `file:${join(module.path, "..", ".tgz-deps", "antelopejs-interface-database-abc1234.tgz")}`,
      "local-tool": `link:${join(module.path, "..", "tools", "local-tool")}`,
      "left-pad": "1.3.0",
      "demo-frontend-vue": "workspace:*",
    });
  });

  it("resolves a $<name> override to the layer's own dependency on it", () => {
    const module = layer(
      "demo-frontend-vue",
      {
        "is-odd": "$is-odd",
        "@antelopejs/interface-core": "$@antelopejs/interface-core",
        "is-even": "$is-even",
      },
      {
        "is-odd": "^3.0.0",
        "@antelopejs/interface-core": "file:../vendor/interface-core.tgz",
      },
    );
    assert.deepEqual(workspaceOverrides([module]), {
      "is-odd": "^3.0.0",
      "@antelopejs/interface-core": `file:${join(module.path, "..", "vendor", "interface-core.tgz")}`,
      "is-even": "$is-even",
      "demo-frontend-vue": "workspace:*",
    });
  });

  it("keeps the layers and --local-package links over a layer's overrides", () => {
    const local = directory("dms-local-");
    const module = layer("demo-frontend-vue", {
      "demo-frontend-vue": "2.0.0",
      "@antelopejs/dms": "1.0.0",
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
