import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import {
  materializeLayers,
  mirrorFiles,
  type ResolvedLayer,
  startLayerWatchers,
  writeFrontendModuleRegistry,
} from "../src/common";
import { readText } from "./helpers/files";
import {
  eventually,
  memory,
  output,
  warnings,
  writeFile,
} from "./helpers/layer-watch";

describe("derived outputs in the dev layer watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-derived-watch-"));
  const workspace = join(root, "workspace");
  const base = join(root, "sources", "base");
  const app = join(root, "sources", "app");
  const baseUi = join(base, "layers", "ui");
  const publicDir = join(workspace, "public");
  const layers: ResolvedLayer[] = [
    { path: base, packageName: "@fixture/base", priority: 1 },
    { path: app, packageName: "@fixture/app", priority: 10 },
  ];
  let stopWatchers: () => Promise<void> = async () => {};

  const read = (path: string): string => readText(path);
  const workspaceFile = (name: string): string => read(join(workspace, name));
  const typePaths = (): string[] =>
    Object.keys(
      JSON.parse(workspaceFile("frontend-paths.generated.json")).compilerOptions
        .paths,
    );
  const registryEntries = (): Array<[string, string | undefined]> =>
    JSON.parse(workspaceFile("generated-frontend-modules.json")).modules.map(
      (module: { id: string; entry?: string }) => [module.id, module.entry],
    );
  const isRestartNotice = (warning: string): boolean =>
    warning.includes("Restart ajs dms dev");

  before(() => {
    writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "@fixture/base" }),
    );
    writeFile(
      join(base, "dms.frontend.ts"),
      "export default { setup() {} };\n",
    );
    writeFile(
      join(baseUi, "app", "components", "Form.vue"),
      "<template><form /></template>\n",
    );
    writeFile(join(baseUi, "public", "logo.svg"), "<svg id='base' />");
    writeFile(
      join(baseUi, "app", "config", "shortcuts-registry.ts"),
      "export default [{ component: 'Form', shortcuts: [] }];\n",
    );
    writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "@fixture/app" }),
    );
    writeFile(
      join(app, "app", "components", "Card.vue"),
      "<template><article /></template>\n",
    );
    mkdirSync(workspace, { recursive: true });
    materializeLayers(workspace, layers);
    writeFrontendModuleRegistry(workspace, layers);
    stopWatchers = startLayerWatchers(
      workspace,
      layers,
      output.ui,
      output.write,
    );
  });

  after(async () => {
    await stopWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  it("mirrors the public files a layer adds, changes and removes", async () => {
    const added = join(baseUi, "public", "images", "new.png");
    await eventually(
      () => {
        writeFile(added, "PNG");
        writeFileSync(
          join(baseUi, "public", "logo.svg"),
          "<svg id='edited' />",
        );
      },
      () =>
        existsSync(join(publicDir, "images", "new.png")) &&
        read(join(publicDir, "logo.svg")) === "<svg id='edited' />",
    );
    assert.equal(read(join(publicDir, "images", "new.png")), "PNG");

    await eventually(
      () => rmSync(added, { force: true }),
      () => !existsSync(join(publicDir, "images", "new.png")),
    );
    assert.ok(!existsSync(join(publicDir, "images")));
    assert.equal(read(join(publicDir, "logo.svg")), "<svg id='edited' />");
  });

  it("lets the higher-priority module keep a contested public file", async () => {
    const override = join(app, "public", "logo.svg");
    await eventually(
      () => writeFile(override, "<svg id='app' />"),
      () => read(join(publicDir, "logo.svg")) === "<svg id='app' />",
    );
    await eventually(
      () => rmSync(join(app, "public"), { recursive: true, force: true }),
      () => read(join(publicDir, "logo.svg")) === "<svg id='edited' />",
    );
    assert.equal(read(join(publicDir, "logo.svg")), "<svg id='edited' />");
  });

  it("aggregates the shortcut registry a module adds, and drops it once removed", async () => {
    const registry = join(app, "app", "config", "shortcuts-registry.ts");
    const aggregated = (): string =>
      workspaceFile("shortcuts-aggregated.generated.ts");
    await eventually(
      () =>
        writeFile(
          registry,
          "export default [{ component: 'Card', shortcuts: [] }];\n",
        ),
      () => aggregated().includes("fixture__app/app/config/shortcuts-registry"),
    );
    assert.match(
      aggregated(),
      /registry0 from "@frontend\/fixture__app\/app\/config\/shortcuts-registry\.ts";\nimport registry1 from "@frontend\/fixture__base\/layers\/ui\/app\/config\/shortcuts-registry\.ts"/,
    );
    await eventually(
      () =>
        rmSync(join(app, "app", "config"), { recursive: true, force: true }),
      () => !aggregated().includes("fixture__app"),
    );
    assert.match(aggregated(), /\[\.\.\.registry0\]/);
  });

  it("loads the entry a module adds, and stops once it is removed", async () => {
    const entry = join(app, "dms.frontend.ts");
    const loader = (): string => workspaceFile("frontend-modules.generated.ts");
    assert.doesNotMatch(loader(), /fixture__app/);
    await eventually(
      () => writeFile(entry, "export default { setup() {} };\n"),
      () => loader().includes('from "@frontend/fixture__app/dms.frontend.ts"'),
    );
    assert.deepEqual(registryEntries(), [
      ["fixture__app", "dms.frontend.ts"],
      ["fixture__base", "dms.frontend.ts"],
    ]);
    await eventually(
      () => rmSync(entry, { force: true }),
      () => !loader().includes("fixture__app"),
    );
    assert.deepEqual(registryEntries(), [
      ["fixture__app", undefined],
      ["fixture__base", "dms.frontend.ts"],
    ]);
  });

  it("imports the app config a layer adds, and drops it once removed", async () => {
    const appConfigs = (): string => workspaceFile("app-configs.generated.ts");
    const baseConfig = join(baseUi, "app", "app.config.ts");
    const appConfig = join(app, "app", "app.config.ts");
    assert.doesNotMatch(appConfigs(), /import config/);
    await eventually(
      () => {
        writeFile(
          baseConfig,
          "export default { branding: { name: 'base' } };\n",
        );
        writeFile(appConfig, "export default { branding: { name: 'app' } };\n");
      },
      () =>
        appConfigs().includes("fixture__app/app/app.config.ts") &&
        appConfigs().includes("fixture__base/layers/ui/app/app.config.ts"),
    );
    assert.match(
      appConfigs(),
      /config0 from "@frontend\/fixture__app\/app\/app\.config\.ts";\nimport config1 from "@frontend\/fixture__base\/layers\/ui\/app\/app\.config\.ts"/,
    );
    await eventually(
      () => rmSync(appConfig, { force: true }),
      () => !appConfigs().includes("fixture__app"),
    );
    assert.match(
      appConfigs(),
      /appConfigs: DmsLayerAppConfig\[\] = \[\{ module: "fixture__base", config: config0 \}\];/,
    );
  });

  it("serves a public file before the source saved with it that names it", async () => {
    const logo = join(app, "public", "branding", "logo-1a2b.png");
    const served = join(publicDir, "branding", "logo-1a2b.png");
    const config = join(
      workspace,
      "frontend-modules",
      "fixture__app",
      "app",
      "app.config.ts",
    );
    const rename = mock.method(fs, "renameSync");
    try {
      await eventually(
        () => {
          writeFile(logo, "PNG");
          writeFile(
            join(app, "app", "app.config.ts"),
            'export default { branding: { logo: "/branding/logo-1a2b.png" } };\n',
          );
        },
        () => existsSync(served) && existsSync(config),
      );
      const renamedTo = rename.mock.calls.map((call) => call.arguments[1]);
      assert.ok(renamedTo.includes(served));
      assert.ok(
        renamedTo.indexOf(served) < renamedTo.indexOf(config),
        renamedTo.join("\n"),
      );
    } finally {
      rename.mock.restore();
    }
  });

  it("says once that a layer directory added or removed needs a restart", async () => {
    const extra = join(base, "layers", "extra");
    output.clear();
    try {
      await eventually(
        () =>
          writeFile(
            join(extra, "app", "utils", "extra.ts"),
            "export const extra = 1;\n",
          ),
        () => typePaths().includes("#extra/*"),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const notices = warnings().filter(isRestartNotice);
      assert.equal(notices.length, 1);
      assert.match(
        notices[0],
        /^\d\d:\d\d:\d\d ▲ New layer directory .+\n {11}→ Restart ajs dms dev to apply it/,
      );
      assert.ok(notices[0].includes(extra), notices[0]);

      await eventually(
        () =>
          writeFileSync(
            join(extra, "app", "utils", "extra.ts"),
            "export const extra = 2;\n",
          ),
        () =>
          read(
            join(
              workspace,
              "frontend-modules",
              "fixture__base",
              "layers",
              "extra",
              "app",
              "utils",
              "extra.ts",
            ),
          ).includes("= 2"),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(warnings().filter(isRestartNotice).length, 1);

      const readme = join(base, "layers", "README.md");
      await eventually(
        () => writeFile(readme, "# Layers\n"),
        () =>
          existsSync(
            join(
              workspace,
              "frontend-modules",
              "fixture__base",
              "layers",
              "README.md",
            ),
          ),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(warnings().filter(isRestartNotice).length, 1);
      rmSync(readme, { force: true });

      await eventually(
        () => rmSync(extra, { recursive: true, force: true }),
        () => !typePaths().includes("#extra/*"),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(warnings().filter(isRestartNotice).length, 1);
    } finally {
      output.clear();
    }
    assert.ok(typePaths().includes("#ui/*"));
  });

  it("writes each output once for changes flushed by several layers together", async () => {
    const contested = join(publicDir, "burst.txt");
    const aggregatedPath = join(workspace, "shortcuts-aggregated.generated.ts");
    const rename = mock.method(fs, "renameSync");
    try {
      await eventually(
        () => {
          writeFile(join(baseUi, "public", "burst.txt"), "base");
          writeFile(join(app, "public", "burst.txt"), "app");
          writeFile(
            join(app, "app", "config", "shortcuts-registry.ts"),
            "export default [];\n",
          );
        },
        () =>
          existsSync(contested) &&
          read(contested) === "app" &&
          read(aggregatedPath).includes("fixture__app"),
      );
      const writesTo = (path: string): number =>
        rename.mock.calls.filter((call) => call.arguments[1] === path).length;
      assert.equal(writesTo(contested), 1);
      assert.equal(writesTo(aggregatedPath), 1);
    } finally {
      rename.mock.restore();
    }
  });

  it("regenerates the other outputs when one of them fails", async () => {
    const locale = join(baseUi, "i18n", "locales", "ui-en-GB.json");
    output.clear();
    try {
      await eventually(
        () => {
          writeFile(locale, '{ "form": {');
          writeFile(join(baseUi, "public", "after-failure.txt"), "served");
        },
        () =>
          existsSync(join(publicDir, "after-failure.txt")) &&
          warnings().some((warning) =>
            warning.includes("is not a valid locale file"),
          ),
      );
      assert.equal(read(join(publicDir, "after-failure.txt")), "served");
    } finally {
      output.clear();
    }
    rmSync(join(baseUi, "i18n"), { recursive: true, force: true });
  });

  it("leaves the derived outputs alone when a change affects none", async () => {
    const markers: Array<[string, string]> = [
      [join(publicDir, "logo.svg"), "marker"],
      [join(workspace, "shortcuts-aggregated.generated.ts"), "// marker\n"],
      [join(workspace, "frontend-modules.generated.ts"), "// marker\n"],
      [join(workspace, "generated-frontend-modules.json"), '{"marker":1}'],
      [join(workspace, "frontend-paths.generated.json"), '{"marker":1}'],
      [join(workspace, "app-configs.generated.ts"), "// marker\n"],
    ];
    for (const [path, content] of markers) writeFileSync(path, content);
    const mirrored = join(
      workspace,
      "frontend-modules",
      "fixture__app",
      "app",
      "components",
      "Card.vue",
    );
    await eventually(
      () =>
        writeFileSync(
          join(app, "app", "components", "Card.vue"),
          "<template><article hidden /></template>\n",
        ),
      () => read(mirrored).includes("hidden"),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const [path, content] of markers) assert.equal(read(path), content);
  });
});

describe("mirrorFiles", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-mirror-files-"));
  const sources = join(root, "sources");
  const dest = join(root, "dest");

  after(() => rmSync(root, { recursive: true, force: true }));

  const source = (name: string, content: string): string => {
    writeFile(join(sources, name), content);
    return join(sources, name);
  };

  it("copies what changed and removes what is no longer listed", () => {
    const files = new Map([
      ["kept.txt", source("kept.txt", "kept")],
      [join("nested", "gone.txt"), source("gone.txt", "gone")],
    ]);
    assert.equal(mirrorFiles(files, dest), true);
    const keptAt = statSync(join(dest, "kept.txt")).mtimeMs;
    assert.equal(mirrorFiles(files, dest), false);

    files.delete(join("nested", "gone.txt"));
    assert.equal(mirrorFiles(files, dest), true);
    assert.ok(!existsSync(join(dest, "nested")));
    assert.equal(statSync(join(dest, "kept.txt")).mtimeMs, keptAt);
  });

  it("replaces a file by a directory of the same name, and back", () => {
    const leaf = source("leaf.txt", "leaf");
    mirrorFiles(new Map([["entry", leaf]]), dest);
    mirrorFiles(new Map([[join("entry", "inner.txt"), leaf]]), dest);
    assert.equal(readText(join(dest, "entry", "inner.txt")), "leaf");

    mirrorFiles(new Map([["entry", leaf]]), dest);
    assert.equal(readText(join(dest, "entry")), "leaf");
  });
});

describe("a quiet dev run's layer watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-layer-watch-quiet-"));
  const workspace = join(root, "workspace");
  const base = join(root, "sources", "base");
  const locale = join(base, "layers", "ui", "i18n", "locales", "ui-en-GB.json");
  const layers: ResolvedLayer[] = [
    { path: base, packageName: "@fixture/base", priority: 1 },
  ];
  let notices = "";
  let stopWatchers: () => Promise<void> = async () => {};

  const catalog = (): Record<string, any> =>
    JSON.parse(readText(join(workspace, "locales.generated", "en.json")));

  before(() => {
    writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "@fixture/base" }),
    );
    writeFile(locale, JSON.stringify({ form: { title: "Form" } }));
    mkdirSync(workspace, { recursive: true });
    materializeLayers(workspace, layers);
    writeFrontendModuleRegistry(workspace, layers);
    stopWatchers = startLayerWatchers(
      workspace,
      layers,
      memory.ui,
      (text) => {
        notices += `${text}\n`;
      },
      true,
    );
  });

  after(async () => {
    await stopWatchers();
    rmSync(root, { recursive: true, force: true });
  });

  it("warns about a failure but not that it is over", async () => {
    await eventually(
      () => writeFileSync(locale, '{ "form": {'),
      () => notices.includes("is not a valid locale file"),
    );
    await eventually(
      () =>
        writeFileSync(
          locale,
          JSON.stringify({ form: { title: "Form", demo_key: "Fixed" } }),
        ),
      () => catalog().form.demo_key === "Fixed",
    );
    assert.match(notices, /^\d\d:\d\d:\d\d ▲ .* is not a valid locale file/);
    assert.doesNotMatch(notices, / ✔ /);
  });
});
