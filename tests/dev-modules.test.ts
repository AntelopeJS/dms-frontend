import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CliError } from "@antelopejs/core/cli";
import { readProjectModulesFresh, withBackendValues } from "../src/dev-modules";
import type { ProjectFrontendModule } from "../src/project-modules";

const MODULE_NAME = "@fixture/module-frontend-vue";

function writeModule(project: string, revision: string): void {
  const module = join(project, "modules", "fixture");
  mkdirSync(join(module, "frontend-vue"), { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ name: "@fixture/module", dmsFrontend: "frontend.js" }),
  );
  writeFileSync(
    join(module, "frontend-vue", "package.json"),
    JSON.stringify({ name: MODULE_NAME }),
  );
  writeFileSync(
    join(module, "frontend.js"),
    `exports.frontendModule = (config, context) => ({
  name: "${MODULE_NAME}",
  sourcePath: require("node:path").join(__dirname, "frontend-vue"),
  renderer: { name: "vue", version: "3" },
  options: { title: config.title, revision: "${revision}", dev: context.dev },
});\n`,
  );
}

function writeConfig(project: string, title: string, modules = ""): void {
  writeFileSync(
    join(project, "antelope.config.ts"),
    `export default {
  name: "fixture",
  modules: {
    fixture: { source: { type: "local", path: "modules/fixture" }, config: { title: "${title}" } },${modules}
  },
};\n`,
  );
}

describe("dev reads the project's modules", () => {
  const project = mkdtempSync(join(tmpdir(), "dms-dev-modules-"));
  after(() => rmSync(project, { recursive: true, force: true }));
  const options = { projectDir: project, environment: "default", dev: true };

  it("as they are on each read, after the configuration and the module change", async () => {
    writeModule(project, "first");
    writeConfig(project, "before");
    const [first] = await readProjectModulesFresh(options);
    assert.deepEqual(first.layer.options, {
      title: "before",
      revision: "first",
      dev: true,
    });

    writeModule(project, "second");
    writeConfig(
      project,
      "after",
      `\n    other: { source: { type: "local", path: "modules/missing" } },`,
    );
    const modules = await readProjectModulesFresh(options);
    assert.deepEqual(
      modules.map((module) => module.layer.options),
      [{ title: "after", revision: "second", dev: true }],
    );
  });

  it("fails with the CLI's own problem when the project cannot be read", async () => {
    await assert.rejects(
      readProjectModulesFresh({
        ...options,
        projectDir: join(project, "nope"),
      }),
      (error: unknown) =>
        error instanceof CliError &&
        error.problem.title.startsWith(
          "Could not evaluate the project's configuration",
        ),
    );
  });
});

describe("dev completes the project's modules with the backend's values", () => {
  const projectModule = (
    name: string,
    options: ProjectFrontendModule["layer"]["options"],
    privateOptions?: ProjectFrontendModule["layer"]["privateOptions"],
  ): ProjectFrontendModule => ({
    layer: { path: `/src/${name}`, name, priority: 0, options, privateOptions },
  });

  it("fills only the private values each module declares, from its own registration", () => {
    const [dms, other] = withBackendValues(
      [
        projectModule(
          "dms",
          {},
          { oauth: { relaySecret: "" }, keys: ["", ""], mode: "" },
        ),
        projectModule("other", {}, { token: "" }),
      ],
      {
        modules: [
          {
            name: "dms",
            priority: 0,
            privateOptions: {
              oauth: { relaySecret: "relay", extra: "undeclared" },
              keys: ["first"],
              mode: { nested: "not a string" },
              undeclared: "dropped",
            },
          },
          { name: "unrelated", priority: 0, privateOptions: { token: "no" } },
        ],
      },
    );
    assert.deepEqual(dms.privateOptions, {
      oauth: { relaySecret: "relay" },
      keys: ["first", ""],
      mode: "",
    });
    assert.deepEqual(other.privateOptions, { token: "" });
  });

  it("rewrites the backend's development origins in the options, whole origins only", () => {
    const [layer] = withBackendValues(
      [
        projectModule("dms", {
          baseURL: "http://127.0.0.1:5010",
          api: "http://127.0.0.1:5010/api?x=1",
          other: "http://127.0.0.1:50100",
          links: ["http://localhost:3001/home", "http://localhost:30010"],
          count: 3,
        }),
      ],
      {
        modules: [],
        originRewrites: [
          { from: "http://127.0.0.1:5010", to: "http://localhost:5011" },
          { from: "http://localhost:3001", to: "http://localhost:3002" },
        ],
      },
    );
    assert.deepEqual(layer.options, {
      baseURL: "http://localhost:5011",
      api: "http://localhost:5011/api?x=1",
      other: "http://127.0.0.1:50100",
      links: ["http://localhost:3002/home", "http://localhost:30010"],
      count: 3,
    });
  });
});
