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

function writeCache(project: string, entries: Record<string, string>): void {
  mkdirSync(join(project, CACHE_FOLDER), { recursive: true });
  writeFileSync(
    join(project, CACHE_FOLDER, "manifest.json"),
    JSON.stringify(entries),
  );
}

function writeConfig(project: string, modules: string): void {
  writeFileSync(
    join(project, "antelope.config.ts"),
    `export default {
  name: "fixture",
  cacheFolder: "${CACHE_FOLDER}",
  modules: {${modules}
  },
};\n`,
  );
}

function writeProject(project: string): void {
  writeModule(join(project, "modules", "local-module"), "@fixture/local");
  writeModule(
    join(project, "node_modules", "@fixture", "installed-module"),
    "@fixture/installed",
  );
  writeModule(
    join(project, CACHE_FOLDER, "@fixture", "cached-module@1.0.0"),
    "@fixture/cached",
  );
  writeModule(
    join(project, CACHE_FOLDER, "git_github_com_Fixture_Git_Module_git"),
    "@fixture/git",
  );
  writeModule(
    join(project, CACHE_FOLDER, "@fixture", "legacy-module"),
    "@fixture/legacy",
  );
  writeCache(project, {
    "@fixture/cached-module@1.0.0": "1.0.0",
    "@fixture/legacy-module": "1.0.0",
  });
  writeConfig(
    project,
    `
    local: { source: { type: "local", path: "modules/local-module" } },
    installed: { source: { type: "package", package: "@fixture/installed-module", version: "1.0.0" } },
    cached: { source: { type: "package", package: "@fixture/cached-module", version: "1.0.0" } },
    legacy: { source: { type: "package", package: "@fixture/legacy-module", version: "1.0.0" } },
    git: { source: { type: "git", remote: "${GIT_REMOTE}" } },`,
  );
}

function writeVersionedProject(project: string): void {
  const versions = ["1.0.0", "1.2.0", "2.0.0"];
  for (const version of versions)
    writeModule(
      join(project, CACHE_FOLDER, "@fixture", `versioned@${version}`),
      `@fixture/versioned-${version}`,
    );
  writeCache(
    project,
    Object.fromEntries(
      versions.map((version) => [`@fixture/versioned@${version}`, version]),
    ),
  );
  writeModule(
    join(project, "node_modules", "@fixture", "versioned"),
    "@fixture/versioned-node-modules",
  );
  mkdirSync(join(project, "antelope-lock", "@fixture", "versioned@1.0.0"), {
    recursive: true,
  });
  writeConfig(
    project,
    `
    locked: { source: { type: "package", package: "@fixture/versioned", version: "^1.0.0" } },
    ranged: { source: { type: "package", package: "@fixture/versioned", version: "^1.1.0" } },
    pinned: { source: { type: "package", package: "@fixture/versioned", version: "2.0.0" } },`,
  );
}

async function layerNames(project: string): Promise<Set<string | undefined>> {
  const modules = await readProjectFrontendModules({
    projectDir: project,
    environment: "default",
  });
  return new Set(modules.map((module) => module.layer.name));
}

void describe("a module's frontend is found wherever AntelopeJS installs its source", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-module-sources-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  void it("loads the frontend of a local, an installed, a cached, a core 1.23.0 cached and a git module", async () => {
    const project = join(root, "sources");
    writeProject(project);

    assert.deepEqual(
      await layerNames(project),
      new Set([
        "@fixture/cached",
        "@fixture/git",
        "@fixture/installed",
        "@fixture/legacy",
        "@fixture/local",
      ]),
    );
  });

  void it("loads each package module from the cached version its spec and the lock resolve to", async () => {
    const project = join(root, "versions");
    writeVersionedProject(project);

    assert.deepEqual(
      await layerNames(project),
      new Set([
        "@fixture/versioned-1.0.0",
        "@fixture/versioned-1.2.0",
        "@fixture/versioned-2.0.0",
      ]),
    );
  });
});
