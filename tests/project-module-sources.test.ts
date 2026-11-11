import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readProjectFrontendModules } from "../src/project-modules";

const CACHE_FOLDER = ".antelope/cache";
const GIT_REMOTE = "git@github.com:Fixture/Git-Module.git";

function writeModule(folder: string, layerName: string): void {
  mkdirSync(join(folder, "frontend-vue"), { recursive: true });
  writeFileSync(
    join(folder, "package.json"),
    JSON.stringify({ name: layerName, dmsFrontend: "frontend.js" }),
  );
  writeFileSync(
    join(folder, "frontend-vue", "package.json"),
    JSON.stringify({ name: `${layerName}-frontend-vue` }),
  );
  writeFileSync(
    join(folder, "frontend.js"),
    `exports.frontendModule = () => ({
  name: "${layerName}",
  sourcePath: require("node:path").join(__dirname, "frontend-vue"),
  renderer: { name: "vue", version: "3" },
});\n`,
  );
}

function writeProject(project: string): void {
  writeModule(join(project, "modules", "local-module"), "@fixture/local");
  writeModule(
    join(project, "node_modules", "@fixture", "package-module"),
    "@fixture/package",
  );
  writeModule(
    join(project, CACHE_FOLDER, "git_github_com_Fixture_Git_Module_git"),
    "@fixture/git",
  );
  writeFileSync(
    join(project, "antelope.config.ts"),
    `export default {
  name: "fixture",
  cacheFolder: "${CACHE_FOLDER}",
  modules: {
    local: { source: { type: "local", path: "modules/local-module" } },
    package: { source: { type: "package", package: "@fixture/package-module", version: "1.0.0" } },
    git: { source: { type: "git", remote: "${GIT_REMOTE}" } },
  },
};\n`,
  );
}

describe("a module's frontend is found wherever AntelopeJS installs its source", () => {
  const project = mkdtempSync(join(tmpdir(), "dms-module-sources-"));
  after(() => rmSync(project, { recursive: true, force: true }));

  it("loads the frontend of a local, a package and a git module", async () => {
    writeProject(project);

    const modules = await readProjectFrontendModules({
      projectDir: project,
      environment: "default",
    });

    assert.deepEqual(
      new Set(modules.map((module) => module.layer.name)),
      new Set(["@fixture/git", "@fixture/local", "@fixture/package"]),
    );
  });
});
