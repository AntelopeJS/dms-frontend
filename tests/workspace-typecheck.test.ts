import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templateTsconfig = join(repoRoot, "templates", "vue", "tsconfig.json");
const tsc = join(repoRoot, "node_modules", "typescript", "bin", "tsc");

const workspaces: string[] = [];
after(() => {
  for (const workspace of workspaces) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

/**
 * Build the part of a generated workspace the typecheck reads: the shipped
 * tsconfig, stubs for the three roots it lists in `files`, and one
 * materialized frontend module.
 *
 * `node_modules` is linked to this repository's so `types: ["vite/client"]`
 * resolves; the config excludes it from the check either way.
 */
function generatedWorkspace(moduleFiles: Record<string, string>): string {
  const workspace = mkdtempSync(join(tmpdir(), "dms-workspace-typecheck-"));
  workspaces.push(workspace);

  symlinkSync(join(repoRoot, "node_modules"), join(workspace, "node_modules"));
  cpSync(templateTsconfig, join(workspace, "tsconfig.json"));
  writeFileSync(
    join(workspace, "frontend-paths.generated.json"),
    '{ "compilerOptions": { "paths": {} } }\n',
  );
  writeFileSync(join(workspace, "globals.d.ts"), "");
  writeFileSync(join(workspace, "auto-imports.d.ts"), "");
  writeFileSync(
    join(workspace, "frontend-modules.generated.ts"),
    "export const frontendModules: unknown[] = [];\n",
  );

  for (const [relativePath, content] of Object.entries(moduleFiles)) {
    const file = join(workspace, "frontend-modules", "fixture", relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return workspace;
}

function typecheck(workspace: string): { code: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [tsc, "--noEmit", "-p", "tsconfig.json"],
      { cwd: workspace, encoding: "utf8" },
    );
    return { code: 0, output };
  } catch (err: any) {
    return { code: err.status ?? 1, output: `${err.stdout ?? ""}` };
  }
}

describe("generated workspace typecheck", () => {
  it("reads module sources the module registry only reaches through a glob", () => {
    // `dms.frontend.ts` loads components with `import.meta.glob`, which
    // TypeScript does not follow, so listing the registry roots in `files`
    // left every component unchecked.
    const workspace = generatedWorkspace({
      "dms.frontend.ts": "export default { setup() {} };\n",
      "probe.ts": 'export const probe: number = "not a number";\n',
    });

    const result = typecheck(workspace);
    assert.notEqual(result.code, 0, "a broken module source must fail");
    assert.match(result.output, /frontend-modules\/fixture\/probe\.ts/);
    assert.match(result.output, /TS2322/);
  });

  it("passes a module whose sources typecheck", () => {
    const workspace = generatedWorkspace({
      "dms.frontend.ts": "export default { setup() {} };\n",
      "probe.ts": "export const probe: number = 1;\n",
      "app/components/widget.ts":
        "export function widget(): string {\n  return 'ok';\n}\n",
    });

    const result = typecheck(workspace);
    assert.equal(result.code, 0, result.output);
  });

  it("ignores the dev-only files a module ships next to its sources", () => {
    // A module's vitest suite and its config import `vitest` and `node:*`,
    // neither of which exists in a browser-only workspace. Excluding them
    // from the roots costs nothing: anything a checked file really imports
    // is still followed.
    const workspace = generatedWorkspace({
      "probe.ts": "export const probe: number = 1;\n",
      "tests/unit.test.ts":
        'import { it } from "vitest";\nit("runs", () => {});\n',
      "vitest.config.ts": 'export { default } from "vitest/config";\n',
      "dist/stale.ts": "export const stale: number = 'compiled output';\n",
    });

    const result = typecheck(workspace);
    assert.equal(result.code, 0, result.output);
  });

  it("covers Vue single-file components too", () => {
    // `tsc` cannot parse `.vue`; vue-tsc, which the verifier runs, reads the
    // same `include`. Pin the effective globs so the two extensions cannot
    // drift apart, and assert the dev-only exclusions are what the previous
    // test relies on.
    const workspace = generatedWorkspace({ "probe.ts": "export {};\n" });
    const config = JSON.parse(
      execFileSync(
        process.execPath,
        [tsc, "--showConfig", "-p", "tsconfig.json"],
        {
          cwd: workspace,
          encoding: "utf8",
        },
      ),
    );

    assert.deepEqual(config.include, [
      "frontend-modules/**/*.ts",
      "frontend-modules/**/*.vue",
    ]);
    for (const pattern of ["**/node_modules", "**/tests", "**/*.test.ts"]) {
      assert.ok(
        config.exclude.includes(pattern),
        `${pattern} must stay excluded`,
      );
    }
  });
});
