import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { checkClientBundle } from "../src/verify-source-client-bundle";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface BuiltChunk {
  file: string;
  name?: string;
  src: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
}

type BuiltManifest = Record<string, BuiltChunk>;

const KPI_CARD_SOURCE = "layers/dms-core/app/components/kpi/KpiCard.vue";

function clientBuild(manifest: BuiltManifest): string {
  const workspace = mkdtempSync(join(tmpdir(), "dms-client-bundle-"));
  roots.push(workspace);
  const assets = join(workspace, "dist", "client", "assets");
  mkdirSync(assets, { recursive: true });
  mkdirSync(join(workspace, "dist", "client", ".vite"));
  writeFileSync(join(assets, "main-1a2b3c.js"), "export const app = 1;");
  writeFileSync(
    join(assets, "lazy-4d5e6f.js"),
    "ApexCharts tiptap auth/login DefaultLayout error.500.title",
  );
  writeFileSync(
    join(workspace, "dist", "client", ".vite", "manifest.json"),
    JSON.stringify(manifest),
  );
  return workspace;
}

const MAIN_CHUNK = {
  "app/main.ts": {
    file: "assets/main-1a2b3c.js",
    name: "main",
    src: "app/main.ts",
    isEntry: true,
    imports: ["_lazy-4d5e6f.js"],
  },
} satisfies BuiltManifest;

describe("The client bundle check", () => {
  it("accepts a build whose manifest has the DmsKpiCard chunk", () => {
    const workspace = clientBuild({
      ...MAIN_CHUNK,
      [KPI_CARD_SOURCE]: {
        file: "assets/lazy-4d5e6f.js",
        name: "KpiCard",
        src: KPI_CARD_SOURCE,
        isDynamicEntry: true,
      },
    });
    assert.doesNotThrow(() => checkClientBundle(workspace));
  });

  it("refuses a build whose manifest has no DmsKpiCard chunk", () => {
    const workspace = clientBuild({
      ...MAIN_CHUNK,
      "layers/dms-core/app/components/kpi/KpiTile.vue": {
        file: "assets/lazy-4d5e6f.js",
        src: "layers/dms-core/app/components/kpi/KpiTile.vue",
      },
    });
    assert.throws(
      () => checkClientBundle(workspace),
      (error: Error) => {
        assert.ok(error instanceof CliError);
        assert.equal(
          error.problem.title,
          "DmsKpiCard is not reachable at runtime",
        );
        return true;
      },
    );
  });
});
