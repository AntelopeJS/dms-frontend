import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { readProjectFrontendModules } from "../src/project-modules";

const MODULE_NAME = "@fixture/module-frontend-vue";

function writeConsumer(project: string): void {
  const module = join(project, "modules", "consumer");
  mkdirSync(join(module, "frontend-vue"), { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({ name: "@fixture/consumer", dmsFrontend: "frontend.js" }),
  );
  writeFileSync(
    join(module, "frontend-vue", "package.json"),
    JSON.stringify({ name: MODULE_NAME }),
  );
  writeFileSync(
    join(module, "frontend.js"),
    `exports.frontendModule = (config) => ({
  name: "${MODULE_NAME}",
  sourcePath: require("node:path").join(__dirname, "frontend-vue"),
  renderer: { name: "vue", version: "3" },
  options: { declared: config.declared, inherited: config.inherited, constructorName: config.constructorName, undeclared: config.undeclared },
});\n`,
  );
}

function writeProvider(project: string, declared: string[]): void {
  const module = join(project, "modules", "provider");
  mkdirSync(module, { recursive: true });
  writeFileSync(
    join(module, "package.json"),
    JSON.stringify({
      name: "@fixture/provider",
      antelopeJs: {
        configVars: declared,
        configVarsFile: "config-vars.js",
      },
    }),
  );
  writeFileSync(
    join(module, "config-vars.js"),
    `exports.configVars = () => ({ REAL: "published" });\n`,
  );
}

function writeConfig(project: string): void {
  writeFileSync(
    join(project, "antelope.config.ts"),
    `export default {
  name: "fixture",
  modules: {
    consumer: {
      source: { type: "local", path: "modules/consumer" },
      config: {
        declared: "\${@provider.REAL}",
        inherited: "to-\${@provider.toString}",
        constructorName: "\${@provider.constructor}",
        undeclared: "u-\${@provider.hasOwnProperty}",
      },
    },
    provider: { source: { type: "local", path: "modules/provider" }, config: {} },
  },
};\n`,
  );
}

describe("config variable references name only what the provider publishes", () => {
  const project = mkdtempSync(join(tmpdir(), "dms-config-var-names-"));
  after(() => rmSync(project, { recursive: true, force: true }));

  it("leaves a reference to an Object.prototype member unresolved, declared or not", async () => {
    writeConsumer(project);
    writeProvider(project, ["REAL", "toString", "constructor"]);
    writeConfig(project);

    const [consumer] = await readProjectFrontendModules({
      projectDir: project,
      environment: "default",
    });

    assert.deepEqual(JSON.parse(JSON.stringify(consumer.layer.options)), {
      declared: "published",
      inherited: "to-${@provider.toString}",
      undeclared: "u-${@provider.hasOwnProperty}",
    });
  });
});
