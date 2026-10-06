import * as assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  copyStaticTemplates,
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../src/common";
import { defineDmsFrontendBuild } from "../templates/vue/frontend-build";
import { autoImportDirectories } from "../templates/vue/frontend-build-loader";

const BUILD_FILE = "dms.frontend.build.ts";

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function declaring(...directories: string[]) {
  return defineDmsFrontendBuild((build) => {
    build.registerAutoImports(directories);
  });
}

function scanned(root: string, declarations: ReturnType<typeof declaring>[]) {
  const warnings: string[] = [];
  const dirs = autoImportDirectories(
    [{ id: "billing", root }],
    declarations.map((setup) => ({ id: "billing", setup })),
    (message) => warnings.push(message),
  );
  return { dirs, warnings };
}

describe("Module build declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "dms-build-module-"));

  it("auto-import nothing for a module that declares nothing", () => {
    assert.deepEqual(scanned(root, []), { dirs: [], warnings: [] });
  });

  it("scan the declared directories, never a module's app/build", () => {
    const { dirs, warnings } = scanned(root, [
      declaring("layers/*/app/composables", "app/utils"),
    ]);
    assert.deepEqual(dirs, [
      { glob: `${root}/layers/*/app/composables/**/*`, types: true },
      { glob: `${root}/app/utils/**/*`, types: true },
      { glob: `!${root}/**/app/build/**`, types: true },
    ]);
    assert.deepEqual(warnings, []);
  });

  it("ignore a declaration of app/build or outside the module, with a warning", () => {
    const rejected = [
      "layers/*/app/build/composables",
      "./app/build",
      "../other/app/composables",
      "/elsewhere/app/composables",
    ];
    const { dirs, warnings } = scanned(root, [
      declaring(...rejected, "app/types"),
    ]);
    assert.deepEqual(
      dirs.map(({ glob }) => glob),
      [`${root}/app/types/**/*`, `!${root}/**/app/build/**`],
    );
    assert.equal(warnings.length, rejected.length);
    rejected.forEach((directory, index) => {
      assert.match(warnings[index], /Frontend module billing declares/);
      assert.ok(warnings[index].includes(`"${directory}"`));
    });
    assert.match(warnings[0], /app\/build\/ holds the module's private code/);
    assert.match(warnings[2], /not inside the module/);
  });

  it("leave app/build out of what a broader declaration covers", async () => {
    const module = mkdtempSync(join(tmpdir(), "dms-build-scan-"));
    writeFixture(
      module,
      "layers/ui/app/composables/usePublic.ts",
      "export function usePublic() {}",
    );
    writeFixture(
      module,
      "layers/ui/app/build/composables/usePrivate.ts",
      "export function usePrivate() {}",
    );
    const { dirs } = scanned(module, [declaring("layers/*/app")]);
    const unimport = createRequire(
      require.resolve("unplugin-auto-import/package.json"),
    ).resolve("unimport");
    const { scanDirExports } = await import(unimport);

    const exports = await scanDirExports(dirs, { cwd: module });

    assert.deepEqual(
      exports.map(({ name }: { name: string }) => name),
      ["usePublic"],
    );
  });
});

describe("The generated build declarations loader", () => {
  function sources() {
    const billing = mkdtempSync(join(tmpdir(), "dms-build-billing-"));
    const crm = mkdtempSync(join(tmpdir(), "dms-build-crm-"));
    writeFixture(
      billing,
      BUILD_FILE,
      [
        'import { defineDmsFrontendBuild } from "#dms/frontend-build";',
        "",
        "export default defineDmsFrontendBuild((build) => {",
        '  build.registerAutoImports(["app/composables", "app/build/types"]);',
        "});",
        "",
      ].join("\n"),
    );
    return [
      { path: billing, name: "@acme/billing-frontend", priority: 2 },
      { path: crm, packageName: "@acme/crm-frontend", priority: 1 },
    ];
  }

  it("lists the modules that have a declaration, under their manifest names", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-build-workspace-"));
    const layers = sources();
    const registry = createFrontendModuleRegistry(workspace, layers);
    assert.deepEqual(
      registry.modules.map(({ name, build }) => ({ name, build })),
      [
        { name: "@acme/billing-frontend", build: BUILD_FILE },
        { name: "@acme/crm-frontend", build: undefined },
      ],
    );

    writeFrontendModuleRegistry(workspace, layers);
    const builds = readFileSync(
      join(workspace, "frontend-builds.generated.ts"),
      "utf8",
    );
    const billingId = registry.modules[0].id;
    assert.match(
      builds,
      new RegExp(
        `import build0 from "\\./frontend-modules/${billingId}/dms\\.frontend\\.build\\.ts";`,
      ),
    );
    assert.match(
      builds,
      new RegExp(`\\{ id: "${billingId}", setup: build0 \\}`),
    );
    assert.doesNotMatch(builds, /build1/);
    assert.deepEqual(
      JSON.parse(
        readFileSync(join(workspace, "frontend-paths.generated.json"), "utf8"),
      ).compilerOptions.paths["#dms/frontend-build"],
      ["./frontend-build.ts"],
    );
  });

  it("hands each module's manifest name to the application's module loader", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-build-workspace-"));
    const layers = sources();
    writeFixture(layers[0].path, "dms.frontend.ts", "export default {};");
    writeFrontendModuleRegistry(workspace, layers);
    const loader = readFileSync(
      join(workspace, "frontend-modules.generated.ts"),
      "utf8",
    );
    assert.match(
      loader,
      /\{ name: "@acme\/billing-frontend", module: module0, options: /,
    );
  });

  it("is what Vite's config loads, resolving the public import, as a config dependency", async () => {
    // Inside the repository, so the bundled config finds `vite` installed.
    const workspace = mkdtempSync(resolve(".frontend-build-"));
    try {
      copyStaticTemplates(workspace);
      writeFixture(workspace, "package.json", '{"type":"module"}');
      const layers = sources();
      const registry = createFrontendModuleRegistry(workspace, layers);
      writeFrontendModuleRegistry(workspace, layers);
      const declaration = join(registry.modules[0].root, BUILD_FILE);
      writeFixture(
        registry.modules[0].root,
        BUILD_FILE,
        readFileSync(join(layers[0].path, BUILD_FILE), "utf8"),
      );
      writeFixture(
        workspace,
        "probe.config.ts",
        [
          'import registry from "./generated-frontend-modules.json";',
          'import { autoImportDirectories } from "./frontend-build-loader";',
          'import { frontendBuilds } from "./frontend-builds.generated";',
          "const warnings: string[] = [];",
          "const dirs = autoImportDirectories(registry.modules, frontendBuilds, (message) => warnings.push(message));",
          "export default { dirs, warnings };",
          "",
        ].join("\n"),
      );
      const { loadConfigFromFile } = await import("vite");

      const loaded = await loadConfigFromFile(
        { command: "build", mode: "production" },
        join(workspace, "probe.config.ts"),
        workspace,
        "silent",
      );

      assert.ok(loaded);
      const root = registry.modules[0].root;
      assert.deepEqual(loaded.config.dirs, [
        { glob: `${root}/app/composables/**/*`, types: true },
        { glob: `!${root}/**/app/build/**`, types: true },
      ]);
      assert.equal((loaded.config.warnings as string[]).length, 1);
      assert.ok(
        loaded.dependencies.some((dependency) =>
          declaration.endsWith(dependency),
        ),
      );
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
