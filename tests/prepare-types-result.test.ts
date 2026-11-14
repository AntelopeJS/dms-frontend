import * as assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { reportPreparation } from "../src/prepare-types-result";
import { memoryUi } from "./fixtures/memory-ui";

void describe("reportPreparation", () => {
  void it("suggests an extends for each module but those under node_modules", () => {
    const project = resolve("/work/project");
    const output = memoryUi();
    reportPreparation(
      {
        ok: true,
        modules: 2,
        out: join(project, ".dms-types"),
        sources: [
          join(project, "node_modules", "@antelopejs", "dms", "frontend-vue"),
          join(project, "shop-vue"),
        ],
      },
      1,
      output.ui,
    );
    const written = `${output.stdout()}${output.stderr()}`;
    assert.match(written, /"\.\.\/\.dms-types\/tsconfig\.json"/);
    assert.match(written, /shop-vue\/tsconfig\.json/);
    assert.doesNotMatch(written, /node_modules/);
  });
});
