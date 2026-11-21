import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  readWorkspacePackageManager,
  readWorkspacePnpmConfig,
} from "./helpers/templates";

void describe("generated workspace pnpm config", () => {
  void it("holds back dependencies published less than a day ago, except @antelopejs packages", () => {
    assert.partialDeepStrictEqual(readWorkspacePnpmConfig(), {
      minimumReleaseAge: 1440,
      minimumReleaseAgeExclude: ["@antelopejs/*"],
    });
  });

  void it("pins a pnpm that knows minimumReleaseAge, which predates 10.16", () => {
    assert.equal(readWorkspacePackageManager(), "pnpm@10.33.0");
  });
});
