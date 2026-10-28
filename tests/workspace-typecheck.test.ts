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
import { writeAppConfigs } from "../src/common";

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
 * tsconfig, stubs for the roots it lists in `files`, and one materialized
 * frontend module.
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
  writeFileSync(
    join(workspace, "app-configs.generated.ts"),
    "export const appConfigs: unknown[] = [];\n",
  );

  for (const [relativePath, content] of Object.entries(moduleFiles)) {
    const file = join(workspace, "frontend-modules", "fixture", relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return workspace;
}

/**
 * A generated workspace wired to the shipped runtime the way `materialize`
 * wires it: the registry and the app configs import `./frontend-module`,
 * modules reach it through `#dms/frontend-module`, and the app configs import
 * the module's through `@frontend/<id>`.
 */
function shippedRuntimeWorkspace(moduleFiles: Record<string, string>): string {
  const workspace = generatedWorkspace(moduleFiles);
  for (const file of [
    "frontend-module.ts",
    "public-options.ts",
    "layer-app-config.ts",
    "ui-app-config.ts",
    "globals.d.ts",
  ]) {
    cpSync(join(repoRoot, "templates", "vue", file), join(workspace, file));
  }
  writeFileSync(
    join(workspace, "frontend-paths.generated.json"),
    '{ "compilerOptions": { "paths": { "#dms/frontend-module": ["./frontend-module.ts"], "@frontend/*": ["./frontend-modules/*"] } } }\n',
  );
  writeFileSync(
    join(workspace, "frontend-modules.generated.ts"),
    'import type { DmsFrontendModuleRegistration } from "./frontend-module";\n\nexport const frontendModules: DmsFrontendModuleRegistration[] = [];\n',
  );
  writeAppConfigs(workspace, {
    modules: [
      { id: "fixture", root: join(workspace, "frontend-modules", "fixture") },
    ],
  });
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

  it("checks the shipped frontend runtime against Vue's public typings", () => {
    const workspace = shippedRuntimeWorkspace({
      "probe.ts":
        'import { useDmsState } from "#dms/frontend-module";\nexport const probe = useDmsState("probe", () => 1);\n',
    });

    const result = typecheck(workspace);
    assert.equal(result.code, 0, result.output);
  });

  it("checks the shipped frontend runtime against the config modules declare", () => {
    const workspace = shippedRuntimeWorkspace({
      "runtime-config.d.ts":
        'declare module "#dms/frontend-module" {\n  interface PublicRuntimeConfig {\n    dms: { baseURL: string };\n  }\n}\n\nexport {};\n',
    });

    const result = typecheck(workspace);
    assert.equal(result.code, 0, result.output);
  });

  it("checks a module's server entry and server files against Node.js and #dms/server", () => {
    const workspace = generatedWorkspace({
      "dms.server.ts":
        'import { defineDmsServer } from "#dms/server";\nimport { digest } from "./server/digest";\n\nexport default defineDmsServer((server) => {\n  server.registerRoute("POST", "/api/_fixture/digest", digest);\n});\n',
      "server/digest.ts":
        'import { createHash } from "node:crypto";\nimport type { DmsServerEvent } from "#dms/server";\n\nexport async function digest(event: DmsServerEvent): Promise<Response> {\n  const { text } = await event.readJson<{ text: string }>();\n  return Response.json({ digest: createHash("sha256").update(text).digest("hex"), id: event.module.id });\n}\n',
    });
    cpSync(
      join(repoRoot, "templates", "vue", "server-module.ts"),
      join(workspace, "server-module.ts"),
    );
    writeFileSync(
      join(workspace, "frontend-paths.generated.json"),
      '{ "compilerOptions": { "paths": { "#dms/server": ["./server-module.ts"] } } }\n',
    );

    const result = typecheck(workspace);
    assert.equal(result.code, 0, result.output);
  });

  it("checks the generated app configs against the shipped runtime", () => {
    const workspace = shippedRuntimeWorkspace({
      "app/app.config.ts":
        'export default defineDmsAppConfig({\n  branding: { logo: "/logo.svg" },\n  ui: { colors: { primary: "green" } },\n});\n',
    });

    const result = typecheck(workspace);
    assert.equal(result.code, 0, result.output);
  });

  it("covers Vue single-file components too", () => {
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
