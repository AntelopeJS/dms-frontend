import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { readSources, type SourceOptions } from "../src/verify-source-sources";

const CORE_LAYER = "@antelopejs/dms-frontend-vue";
const INSTALLED_DMS = "node_modules/@antelopejs/dms";

const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A project directory holding `files`, by path relative to its root. */
function project(files: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dms-sources-")));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(
      join(root, path),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }
  return root;
}

/** A frontend package named `name` at `root`. */
function frontendPackage(root: string, name: string): Record<string, unknown> {
  return {
    [`${root}/package.json`]: { name },
    [`${root}/dms.frontend.ts`]: "export default {};\n",
  };
}

/** `@antelopejs/dms` at `version`, installed with its core layer. */
function installedDms(version = "9.9.9"): Record<string, unknown> {
  return {
    [`${INSTALLED_DMS}/package.json`]: {
      name: "@antelopejs/dms",
      version,
      exports: { ".": "./index.js", "./package.json": "./package.json" },
    },
    ...frontendPackage(`${INSTALLED_DMS}/frontend-vue`, CORE_LAYER),
  };
}

const DEMO_PROJECT = {
  "package.json": { name: "demo" },
  ...frontendPackage("frontend-vue", "demo-frontend-vue"),
};

function sources(projectDir: string, options: Partial<SourceOptions> = {}) {
  return readSources({
    projectDir,
    moduleSources: [],
    localPackages: {},
    ...options,
  });
}

/** The problem `run` stops with, as a usage error. */
function usageProblem(run: () => unknown) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof CliError, String(error));
    assert.equal(error.problem.exitCode, 2);
    return error.problem;
  }
  assert.fail("expected a usage error");
}

describe("reading the packages verify-source builds", () => {
  it("verifies the project's module on the core layer it installs", () => {
    const root = project({ ...DEMO_PROJECT, ...installedDms() });
    const { layers, coreLayer } = sources(root, {
      moduleSources: [join(root, "frontend-vue")],
    });
    assert.equal(
      coreLayer,
      "@antelopejs/dms 9.9.9 (installed in this project)",
    );
    assert.deepEqual(
      layers.map((layer) => [layer.packageName, layer.path]),
      [
        [CORE_LAYER, join(root, INSTALLED_DMS, "frontend-vue")],
        ["demo-frontend-vue", join(root, "frontend-vue")],
      ],
    );
  });

  it("resolves @antelopejs/dms the way Node does, from a parent directory", () => {
    const root = project({ ...DEMO_PROJECT, ...installedDms("0.5.5") });
    const { layers, coreLayer } = sources(join(root, "frontend-vue"));
    assert.equal(
      coreLayer,
      "@antelopejs/dms 0.5.5 (installed in this project)",
    );
    assert.deepEqual(
      layers.map((layer) => layer.packageName),
      [CORE_LAYER, "demo-frontend-vue"],
    );
  });

  it("defaults to the project's frontend-vue module", () => {
    const root = project({ ...DEMO_PROJECT, ...installedDms() });
    assert.deepEqual(
      sources(root).layers.map((layer) => layer.packageName),
      [CORE_LAYER, "demo-frontend-vue"],
    );
  });

  it("verifies an unpublished core layer passed with -l instead", () => {
    const root = project({
      ...DEMO_PROJECT,
      ...installedDms(),
      ...frontendPackage("dms/frontend-vue", CORE_LAYER),
    });
    const { layers, coreLayer } = sources(root, {
      layerSource: join(root, "dms/frontend-vue"),
      moduleSources: [join(root, "frontend-vue")],
    });
    assert.match(coreLayer, /^the DMS core layer in .*dms\/frontend-vue$/);
    assert.deepEqual(
      layers.map((layer) => layer.path),
      [join(root, "dms/frontend-vue"), join(root, "frontend-vue")],
    );
  });

  it("verifies the core layer alone when -l names it", () => {
    const root = project(frontendPackage("frontend-vue", CORE_LAYER));
    const { layers } = sources(root, {
      layerSource: join(root, "frontend-vue"),
    });
    assert.deepEqual(
      layers.map((layer) => layer.packageName),
      [CORE_LAYER],
    );
  });

  it("takes a core layer passed as a module as the layer", () => {
    const root = project(frontendPackage("frontend-vue", CORE_LAYER));
    const { layers, coreLayer } = sources(root);
    assert.match(coreLayer, /^the DMS core layer in /);
    assert.deepEqual(
      layers.map((layer) => layer.packageName),
      [CORE_LAYER],
    );
  });

  it("asks to install @antelopejs/dms with the project's package manager", () => {
    const root = project(DEMO_PROJECT);
    const problem = usageProblem(() => sources(root));
    assert.equal(
      problem.title,
      "@antelopejs/dms is not installed in this project",
    );
    assert.deepEqual(problem.fixes, [
      "Add it as a development dependency: pnpm add -D @antelopejs/dms",
    ]);

    const npmProject = project({ ...DEMO_PROJECT, "package-lock.json": {} });
    assert.deepEqual(usageProblem(() => sources(npmProject)).fixes, [
      "Add it as a development dependency: npm install -D @antelopejs/dms",
    ]);

    const yarnProject = project({
      ...DEMO_PROJECT,
      "package.json": { name: "demo", packageManager: "yarn@4.9.1" },
    });
    assert.deepEqual(usageProblem(() => sources(yarnProject)).fixes, [
      "Add it as a development dependency: yarn add -D @antelopejs/dms",
    ]);
  });

  it("names an installed release without a core layer", () => {
    const root = project({
      ...DEMO_PROJECT,
      [`${INSTALLED_DMS}/package.json`]: {
        name: "@antelopejs/dms",
        version: "0.1.0",
      },
    });
    const problem = usageProblem(() => sources(root));
    assert.equal(
      problem.title,
      "@antelopejs/dms 0.1.0 ships no DMS core layer",
    );
    assert.deepEqual(problem.fixes, [
      "Update it: pnpm add -D @antelopejs/dms@latest",
    ]);
  });

  it("sends a frontend module passed with -l to -m", () => {
    const root = project({ ...DEMO_PROJECT, ...installedDms() });
    const module = join(root, "frontend-vue");
    const problem = usageProblem(() =>
      sources(root, {
        layerSource: module,
        localPackages: { "@antelopejs/interface-dms": "/opt/interface-dms" },
      }),
    );
    assert.match(problem.title, /frontend-vue is not the DMS core layer$/);
    assert.match(
      problem.reason ?? "",
      /--layer is for verifying an unpublished DMS core layer, @antelopejs\/dms-frontend-vue, and .*frontend-vue holds demo-frontend-vue\./,
    );
    assert.deepEqual(problem.fixes, [
      `Drop -l and pass the folder with -m: ajs dms verify-source -m ${module} ` +
        "--local-package @antelopejs/interface-dms=/opt/interface-dms",
    ]);
  });

  it("asks for a module when the project has none", () => {
    const root = project({ "package.json": { name: "backend" } });
    const problem = usageProblem(() => sources(root));
    assert.equal(problem.title, "No frontend module to verify");
  });
});
