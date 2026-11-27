import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { buildAndTypeCheck } from "../src/verify-source-build";
import { ViteWarnings } from "../src/vite-output";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

const VITE_BIN = join(
  dirname(require.resolve("vite/package.json")),
  "bin",
  "vite.js",
);

function workspaceBuildingWithVite84(): string {
  const workspace = temporaryDirectory("dms-verify-build-");
  const vite = JSON.stringify(VITE_BIN);
  const scripts = {
    "build:client": `node ${vite} build`,
    "build:ssr": `node ${vite} build --ssr ssr-renderer.ts --outDir dist/ssr`,
    "build:email": "node -e 0",
    "build:server": "node -e 0",
  };
  const files = {
    "package.json": JSON.stringify({ private: true, type: "module", scripts }),
    "index.html": '<script type="module" src="/main.js"></script>',
    "main.js": "console.log(1);",
    "ssr-renderer.ts": "export const render = 1;",
    "typecheck-loader.mjs": "",
    "tsconfig.verify.json": "{}",
    "node_modules/vue-tsc/bin/vue-tsc.js": "",
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(workspace, file)), { recursive: true });
    writeFileSync(join(workspace, file), content);
  }
  return workspace;
}

void describe("The source verification's build steps", () => {
  void it("build the client and the SSR bundle of one project without Vite's command lock refusing the second", async () => {
    await assert.doesNotReject(
      buildAndTypeCheck({
        workspace: workspaceBuildingWithVite84(),
        env: process.env,
        mapLine: (line) => line,
        warnings: new ViteWarnings(),
        isVerbose: true,
      }),
    );
  });
});
