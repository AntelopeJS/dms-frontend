import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { serverNodeOptions } from "../src/node-options";

describe("the NODE_OPTIONS of a dev server or a build", () => {
  it("keeps the caller's options, so a --require preload reaches the server", () => {
    assert.equal(
      serverNodeOptions("--require /srv/clock.js"),
      "--max-old-space-size=4096 --require /srv/clock.js",
    );
  });

  it("puts the caller's heap size last, so it wins over the default", () => {
    assert.equal(
      serverNodeOptions("--max-old-space-size=8192"),
      "--max-old-space-size=4096 --max-old-space-size=8192",
    );
  });

  it("gives the default heap alone when the caller sets none", () => {
    assert.equal(serverNodeOptions(undefined), "--max-old-space-size=4096");
    assert.equal(serverNodeOptions("  "), "--max-old-space-size=4096");
  });
});
