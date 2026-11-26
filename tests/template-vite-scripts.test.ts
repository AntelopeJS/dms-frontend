import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { templateViteArguments } from "./helpers/template-scripts";

const VITE_BIN = join(
  dirname(require.resolve("vite/package.json")),
  "bin",
  "vite.js",
);

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function run(
  root: string,
  args: string[],
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITE_BIN, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.stderr.on("data", (chunk: Buffer) => (output += String(chunk)));
    child.on("close", (code) => resolve({ code, output }));
  });
}

void describe("The template's vite build scripts", () => {
  void it("run side by side in one project, as the source verification runs them", async () => {
    const root = mkdtempSync(join(tmpdir(), "dms-vite-lock-"));
    roots.push(root);
    writeFileSync(
      join(root, "index.html"),
      '<script type="module" src="/main.js"></script>',
    );
    writeFileSync(join(root, "main.js"), "console.log(1);");
    writeFileSync(join(root, "ssr-renderer.ts"), "export const render = 1;");
    const [client, ssr] = await Promise.all([
      run(root, templateViteArguments("build:client")),
      run(root, templateViteArguments("build:ssr")),
    ]);
    assert.equal(client.code, 0, client.output);
    assert.equal(ssr.code, 0, ssr.output);
  });
});
