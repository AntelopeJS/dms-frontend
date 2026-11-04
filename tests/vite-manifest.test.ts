import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { parseViteManifest } from "../src/internal/vite-manifest";

describe("parseViteManifest", () => {
  it("lists the chunks of a manifest, in its order", () => {
    assert.deepEqual(
      parseViteManifest(
        JSON.stringify({
          "main.ts": { file: "assets/main.js", isEntry: true, css: ["a.css"] },
          "page.vue": { file: "assets/page.js", src: "page.vue" },
        }),
        "client build manifest",
      ),
      [
        { file: "assets/main.js", isEntry: true, css: ["a.css"] },
        { file: "assets/page.js", src: "page.vue" },
      ],
    );
    assert.deepEqual(parseViteManifest("{}", "manifest"), []);
  });

  it("refuses what is not an object of chunks that name their file", () => {
    for (const content of [
      "null",
      "[]",
      '"abc"',
      "5",
      '{"a":null}',
      '{"a":{}}',
      '{"a":{"file":5}}',
      '{"a":{"file":"x.js","isEntry":"yes"}}',
      '{"a":{"file":"x.js","src":5}}',
      '{"a":{"file":"x.js"},"b":"y.js"}',
    ])
      assert.throws(
        () => parseViteManifest(content, "e-mail build manifest"),
        (error: Error) => {
          assert.ok(error instanceof CliError, content);
          assert.equal(
            error.problem.title,
            "The e-mail build manifest is not a Vite manifest",
          );
          return true;
        },
        content,
      );
  });
});
