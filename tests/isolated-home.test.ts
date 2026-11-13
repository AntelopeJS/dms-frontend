import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { showPath } from "../src/output";
import { isolateHome } from "./helpers/isolated-home";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Runs `body` with the temp directory inside the home directory, the way a developer's `TMPDIR` can put it. */
function withTempDirInsideHome(body: () => void): void {
  const home = mkdtempSync(join(tmpdir(), "dms-isolated-home-"));
  roots.push(home);
  const temp = join(home, "tmp");
  mkdirSync(temp);
  const saved = { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR };
  process.env.HOME = home;
  process.env.TMPDIR = temp;
  try {
    body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

void describe("isolated home", () => {
  void it("shows a temp directory under the real home in full, not from `~`", () => {
    withTempDirInsideHome(() => {
      const restore = isolateHome();
      try {
        const target = join(tmpdir(), "layer");
        assert.equal(showPath(target), target);
      } finally {
        restore();
      }
    });
  });

  void it("gives the home back when the test is done", () => {
    withTempDirInsideHome(() => {
      const before = homedir();
      isolateHome()();
      assert.equal(homedir(), before);
    });
  });
});
