import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = join(repoRoot, "scripts", "typecheck-projects.ts");

/** The tsconfig a test project is written with. */
interface ProjectConfig {
  compilerOptions: Record<string, boolean | string | string[]>;
  include: string[];
}

const CONFIG: ProjectConfig = {
  compilerOptions: {
    strict: true,
    allowJs: true,
    checkJs: true,
    module: "esnext",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    types: [],
  },
  include: ["./*.mjs"],
};

/** A project that lists `own.mjs` and reaches `imported.ts` only through its import. */
function project(
  own: string,
  imported: string,
  config: ProjectConfig = CONFIG,
): string {
  const directory = temporaryDirectory("dms-typecheck-projects-");
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify(config));
  writeFileSync(join(directory, "own.mjs"), own);
  writeFileSync(join(directory, "imported.ts"), imported);
  return join(directory, "tsconfig.json");
}

interface RunnerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function typecheck(...configFiles: string[]): Promise<RunnerResult> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", runner, ...configFiles],
    { cwd: repoRoot },
  );
  const result: RunnerResult = { status: null, stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    result.stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    result.stderr += chunk;
  });
  return new Promise((resolveResult, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      result.status = status;
      resolveResult(result);
    });
  });
}

void describe("typecheck-projects", { concurrency: true }, () => {
  void it("fails on a JSDoc type the project's own .mjs file contradicts", async () => {
    const config = project(
      'import { imported } from "./imported.ts";\n/** @type {string} */\nexport const own = imported;\n',
      "export const imported: number = 1;\n",
    );

    const result = await typecheck(config);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /own\.mjs\(3,14\): error TS2322:/);
  });

  void it("leaves the errors of a file the project only imports to that file's own project", async () => {
    const config = project(
      'import { imported } from "./imported.ts";\n/** @type {number} */\nexport const own = imported;\n',
      'export const imported: number = "text";\n',
    );

    const result = await typecheck(config);

    assert.deepEqual(result, { status: 0, stderr: "", stdout: "" });
  });

  void it("fails on an error in the project's own tsconfig, such as a misspelled checkJs", async () => {
    const config = project(
      '/** @type {number} */\nexport const own = "text";\n',
      "export const imported = 1;\n",
      {
        ...CONFIG,
        compilerOptions: {
          ...Object.fromEntries(
            Object.entries(CONFIG.compilerOptions).filter(
              ([option]) => option !== "checkJs",
            ),
          ),
          checkJS: true,
        },
      },
    );

    const result = await typecheck(config);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /tsconfig\.json\(\d+,\d+\): error TS5025:/);
  });

  void it("fails when any of the projects it is given fails", async () => {
    const clean = project(
      "/** @type {number} */\nexport const own = 1;\n",
      "export const imported = 1;\n",
    );
    const broken = project(
      '/** @type {number} */\nexport const own = "text";\n',
      "export const imported = 1;\n",
    );

    const result = await typecheck(clean, broken);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /own\.mjs\(2,14\): error TS2322:/);
  });
});
