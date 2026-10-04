import assert from "node:assert/strict";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it, mock } from "node:test";
import {
  affectsLocaleMessages,
  materializeLayers,
  mirrorFiles,
  type ResolvedLayer,
  startLayerWatchers,
  writeFrontendModuleRegistry,
} from "../src/common";
import { memoryUi } from "./fixtures/memory-ui";

const memory = memoryUi();
let written = "";

/** What the watchers print while dev runs. */
const output = {
  ui: memory.ui,
  write: (text: string) => {
    written += `${text}\n`;
  },
  stderr: () => written,
  clear: () => {
    written = "";
  },
};

/** Each notice the watchers printed, with its detail lines. */
function warnings(): string[] {
  return output.stderr().split(/\n(?=\S)/);
}

const RETRY_WRITE_MS = 1_000;
const TIMEOUT_MS = 15_000;

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Wait until `done` holds, repeating `act` meanwhile: a change made before the
 * watcher has finished its initial scan is not reported, so the first write
 * alone could be lost.
 */
async function eventually(act: () => void, done: () => boolean): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastAct = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastAct >= RETRY_WRITE_MS) {
      act();
      lastAct = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (done()) return;
  }
  assert.fail("the watcher did not apply the change in time");
}

describe("locale catalogs in the dev layer watcher", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-layer-watch-"));
  const workspace = join(root, "workspace");
  const base = join(root, "sources", "base");
  const app = join(root, "sources", "app");
  const baseLocales = join(base, "layers", "ui", "i18n", "locales");
  const generated = join(workspace, "locales.generated");
  const layers: ResolvedLayer[] = [
    { path: base, packageName: "@fixture/base", priority: 1 },
    { path: app, packageName: "@fixture/app", priority: 10 },
  ];
  let stopWatchers: () => Promise<void> = async () => {};

  const catalog = (locale: string): Record<string, any> =>
    JSON.parse(readFileSync(join(generated, `${locale}.json`), "utf8"));
  const emailLocales = (): string[] =>
    JSON.parse(
      readFileSync(join(workspace, "email-locales.generated.json"), "utf8"),
    );
  const mtime = (path: string): number => statSync(path).mtimeMs;

  before(() => {
    writeFile(
      join(base, "package.json"),
      JSON.stringify({ name: "@fixture/base" }),
    );
    writeFile(
      join(base, "layers", "ui", "app", "components", "Form.vue"),
      "<template><form /></template>\n",
    );
    writeFile(
      join(baseLocales, "ui-en-GB.json"),
      JSON.stringify({ form: { title: "Form", owner: "base" } }),
    );
    writeFile(
      join(baseLocales, "ui-fr-FR.json"),
      JSON.stringify({ form: { title: "Formulaire" } }),
    );
    writeFile(
      join(app, "package.json"),
      JSON.stringify({ name: "@fixture/app" }),
    );
    writeFile(
      join(app, "i18n", "locales", "app-en-GB.json"),
      JSON.stringify({ form: { owner: "app" } }),
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

  it("regenerates the merged catalogs when a layer adds a key", async () => {
    assert.deepEqual(catalog("en").form, {
      title: "Form",
      owner: "app",
    });
    await eventually(
      () =>
        writeFileSync(
          join(baseLocales, "ui-en-GB.json"),
          JSON.stringify({
            form: { title: "Form", owner: "base", demo_key: "Hello" },
          }),
        ),
      () => catalog("en").form.demo_key === "Hello",
    );
    // The higher-priority module still wins, as at materialization.
    assert.equal(catalog("en").form.owner, "app");
    assert.match(
      readFileSync(join(generated, "en.ts"), "utf8"),
      /"demo_key":"Hello"/,
    );
    assert.deepEqual(emailLocales(), ["en", "fr"]);
  });

  it("rewrites only the files whose content changed", async () => {
    const untouched = [
      join(generated, "en.json"),
      join(generated, "en.ts"),
      join(workspace, "locales.generated.ts"),
      join(workspace, "email-locales.generated.json"),
    ];
    const before = untouched.map(mtime);
    await eventually(
      () => {
        // Same English messages, laid out differently, in the same pass as a
        // French change.
        writeFileSync(
          join(baseLocales, "ui-en-GB.json"),
          JSON.stringify(
            { form: { title: "Form", owner: "base", demo_key: "Hello" } },
            null,
            2,
          ),
        );
        writeFileSync(
          join(baseLocales, "ui-fr-FR.json"),
          JSON.stringify({ form: { title: "Formulaire modifié" } }),
        );
      },
      () => catalog("fr").form.title === "Formulaire modifié",
    );
    assert.deepEqual(untouched.map(mtime), before);
  });

  it("regenerates once for changes flushed by several layers together", async () => {
    // What a checkout or an editor saving several files does. One regeneration
    // per layer would write the first layer's change alone, then both within a
    // few milliseconds: Vite's watcher drops that second change on Linux.
    const catalogPath = join(generated, "en.json");
    const rename = mock.method(fs, "renameSync");
    try {
      await eventually(
        () => {
          writeFileSync(
            join(baseLocales, "ui-en-GB.json"),
            JSON.stringify({
              form: { title: "Form (both)", owner: "base", demo_key: "Hello" },
            }),
          );
          writeFileSync(
            join(app, "i18n", "locales", "app-en-GB.json"),
            JSON.stringify({ form: { owner: "app", both: true } }),
          );
        },
        () =>
          catalog("en").form.title === "Form (both)" &&
          catalog("en").form.both === true,
      );
      const catalogWrites = rename.mock.calls.filter(
        (call) => call.arguments[1] === catalogPath,
      );
      assert.equal(catalogWrites.length, 1);
    } finally {
      rename.mock.restore();
    }
  });

  it("adds and removes a locale", async () => {
    const german = join(baseLocales, "ui-de-DE.json");
    await eventually(
      () =>
        writeFileSync(german, JSON.stringify({ form: { title: "Formular" } })),
      () => existsSync(join(generated, "de.json")),
    );
    assert.equal(catalog("de").form.title, "Formular");
    assert.ok(existsSync(join(generated, "de.ts")));
    assert.deepEqual(emailLocales().sort(), ["de", "en", "fr"]);
    assert.match(
      readFileSync(join(workspace, "locales.generated.ts"), "utf8"),
      /"de": \(\) => import\("\.\/locales\.generated\/de"\)/,
    );

    await eventually(
      () => rmSync(german, { force: true }),
      () => !existsSync(join(generated, "de.json")),
    );
    assert.ok(!existsSync(join(generated, "de.ts")));
    assert.deepEqual(emailLocales(), ["en", "fr"]);
    assert.doesNotMatch(
      readFileSync(join(workspace, "locales.generated.ts"), "utf8"),
      /locales\.generated\/de/,
    );
  });

  it("keeps the previous catalogs while a locale file does not parse", async () => {
    const file = join(baseLocales, "ui-en-GB.json");
    const isFailure = (warning: string) =>
      warning.includes("is not a valid locale file");
    output.clear();
    try {
      await eventually(
        () => writeFileSync(file, '{ "form": {'),
        () => warnings().some(isFailure),
      );
      const failure = warnings().find(isFailure) ?? "";
      assert.ok(
        failure.startsWith(`${failure.slice(0, 8)} ▲ ${file} is not a valid`),
        failure,
      );
      assert.match(failure, /^\d\d:\d\d:\d\d ▲ /);
      assert.match(failure, /\n {11}.*JSON/);
      assert.match(
        failure,
        /\n {11}The dev server keeps the previous locale catalogs until the file is fixed\.\n$/,
      );
      assert.doesNotMatch(failure, /frontend-modules|\.antelopejs/);
      assert.doesNotMatch(failure, /^\s+at /m, "no stack trace");
      assert.equal(catalog("en").form.demo_key, "Hello");

      await eventually(
        () =>
          writeFileSync(
            file,
            JSON.stringify({ form: { title: "Form", demo_key: "Fixed" } }),
          ),
        () => catalog("en").form.demo_key === "Fixed",
      );
      const fixed = warnings().filter((line) => line.includes(" ✔ "));
      assert.deepEqual(
        fixed.map((line) => line.slice(9)),
        [`✔ ${file} fixed · locale catalogs regenerated\n`],
      );
    } finally {
      output.clear();
    }
  });

  it("leaves the catalogs alone when a change is not a locale file", async () => {
    // A regeneration would put the catalog back: its absence shows none ran.
    writeFileSync(join(generated, "en.json"), '{"form":{"marker":true}}');
    const component = join(
      base,
      "layers",
      "ui",
      "app",
      "components",
      "Form.vue",
    );
    const mirrored = join(
      workspace,
      "frontend-modules",
      "fixture__base",
      "layers",
      "ui",
      "app",
      "components",
      "Form.vue",
    );
    await eventually(
      () =>
        writeFileSync(component, "<template><form novalidate /></template>\n"),
      () => readFileSync(mirrored, "utf8").includes("novalidate"),
    );
    // Longer than the delay a regeneration waits for, had one been scheduled.
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(catalog("en"), { form: { marker: true } });
  });
});

describe("affectsLocaleMessages", () => {
  it("matches the locale directories of a module and of its layers", () => {
    for (const path of [
      "i18n/locales/app-en-GB.json",
      "i18n/locales",
      "i18n",
      "layers/ui/i18n/locales/ui-en-GB.json",
      "layers/ui/i18n/locales/nested/extra-fr-FR.json",
      "layers/ui/i18n",
      "layers/ui",
      "layers",
    ])
      assert.equal(affectsLocaleMessages(path), true, path);
    for (const path of [
      "app/components/Form.vue",
      "layers/ui/app/components/Form.vue",
      "layers/ui/public/i18n/locales/en-GB.json",
      "i18n/messages/en-GB.json",
      "package.json",
    ])
      assert.equal(affectsLocaleMessages(path), false, path);
  });
});

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

  const read = (path: string): string => readFileSync(path, "utf8");
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
    // The directory it leaves empty goes with it, as a restart would do.
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
    // Highest priority first, as at materialization.
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

      // A change that leaves the layer directories alone says nothing.
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

      // Nor does a file next to the layers: the type paths are rewritten
      // with the same content, which is what the notice waits for.
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
      // Nor does removing it: one restart applies both changes.
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
    } finally {
      output.clear();
    }
    rmSync(join(baseUi, "i18n"), { recursive: true, force: true });
  });

  it("leaves the derived outputs alone when a change affects none", async () => {
    // A regeneration would put these back: their survival shows none ran.
    const markers: Array<[string, string]> = [
      [join(publicDir, "logo.svg"), "marker"],
      [join(workspace, "shortcuts-aggregated.generated.ts"), "// marker\n"],
      [join(workspace, "frontend-modules.generated.ts"), "// marker\n"],
      [join(workspace, "generated-frontend-modules.json"), '{"marker":1}'],
      [join(workspace, "frontend-paths.generated.json"), '{"marker":1}'],
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
    // Longer than the delay a regeneration waits for, had one been scheduled.
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
    assert.equal(
      readFileSync(join(dest, "entry", "inner.txt"), "utf8"),
      "leaf",
    );

    mirrorFiles(new Map([["entry", leaf]]), dest);
    assert.equal(readFileSync(join(dest, "entry"), "utf8"), "leaf");
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
    JSON.parse(
      readFileSync(join(workspace, "locales.generated", "en.json"), "utf8"),
    );

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
