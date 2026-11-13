import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { build, loadConfigFromFile } from "vite";
import {
  copyStaticTemplates,
  writeFrontendModuleRegistry,
} from "../src/common";
import { materializeLayers } from "../src/materialize";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";

const PROBE = "__dmsVitePluginsWorkerProbe";

function moduleRegisteringProbe(): string {
  const module = temporaryDirectory("dms-worker-plugins-module-");
  writeFileSync(
    join(module, "package.json"),
    '{"name":"@acme/billing-frontend","version":"1.0.0"}',
  );
  writeFileSync(
    join(module, "dms.frontend.build.ts"),
    [
      'import { defineDmsFrontendBuild } from "#dms/frontend-build";',
      "export default defineDmsFrontendBuild((build) => {",
      `  build.registerVitePlugins(() => [{ name: "probe", enforce: "pre", resolveId(id: string) { Reflect.get(globalThis, "${PROBE}").push(id); return null; } }]);`,
      "});",
      "",
    ].join("\n"),
  );
  return module;
}

function projectSpawningWorker(): string {
  const root = temporaryDirectory("dms-worker-plugins-project-");
  for (const [path, content] of [
    [
      "entry.js",
      'new Worker(new URL("./work.js", import.meta.url), { type: "module" });\n',
    ],
    ["work.js", 'import { answer } from "./dep.js";\nconsole.log(answer);\n'],
    ["dep.js", "export const answer = 42;\n"],
  ])
    writeFileSync(join(root, path), content);
  return root;
}

void it("applies a module's registered Vite plugins to a worker's imports", async () => {
  const module = moduleRegisteringProbe();
  const layers = [
    {
      path: module,
      name: "@acme/billing-frontend",
      packageName: "@acme/billing-frontend",
      priority: 1,
    },
  ];
  const workspace = mkdtempSync(resolve(".vite-worker-plugins-"));
  const seen: string[] = [];
  Reflect.set(globalThis, PROBE, seen);
  try {
    copyStaticTemplates(workspace);
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFrontendModuleRegistry(workspace, layers);
    materializeLayers(workspace, layers);
    const nuxtUi = join(workspace, "node_modules", "@nuxt", "ui");
    mkdirSync(nuxtUi, { recursive: true });
    writeFileSync(
      join(nuxtUi, "package.json"),
      '{"name":"@nuxt/ui","type":"module","exports":{"./vite":"./vite.mjs"}}',
    );
    writeFileSync(
      join(nuxtUi, "vite.mjs"),
      "export default () => ({ name: 'fixture-nuxt-ui' });\n",
    );
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      join(workspace, "vite.config.ts"),
      workspace,
      "silent",
    );
    assert.ok(loaded);
    const root = projectSpawningWorker();

    await build({
      root,
      configFile: false,
      logLevel: "silent",
      worker: loaded.config.worker,
      build: {
        write: false,
        rolldownOptions: { input: join(root, "entry.js") },
      },
    });

    assert.ok(
      seen.some((id) => id.endsWith("dep.js")),
      `the probe saw no import of dep.js, only: ${seen.join(", ")}`,
    );
  } finally {
    Reflect.deleteProperty(globalThis, PROBE);
    rmSync(workspace, { recursive: true, force: true });
  }
});
