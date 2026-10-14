import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  collectAuthEstablishEndpoints,
  copyStaticTemplates,
  createFrontendModuleRegistry,
  toPosixPath,
  writeDmsMainCss,
  writeFrontendModuleRegistry,
} from "../src/common";

describe("Vite frontend generation", () => {
  it("discovers Vue entries and the stable SDK alias", () => {
    const source = mkdtempSync(join(tmpdir(), "dms-vue-module-"));
    const workspace = mkdtempSync(join(tmpdir(), "dms-vue-workspace-"));
    writeFileSync(join(source, "dms.frontend.ts"), "export default {};");
    const registry = createFrontendModuleRegistry(workspace, [
      { path: source, packageName: "@dms/vue", priority: 7 },
    ]);
    assert.equal(registry.modules[0].entry, "dms.frontend.ts");
    writeFrontendModuleRegistry(workspace, [
      { path: source, packageName: "@dms/vue", priority: 7 },
    ]);
    const paths = readFileSync(
      join(workspace, "frontend-paths.generated.json"),
      "utf8",
    );
    const loader = readFileSync(
      join(workspace, "frontend-modules.generated.ts"),
      "utf8",
    );
    assert.match(paths, /#dms\/frontend-module/);
    assert.match(loader, /dms\.frontend\.ts/);
  });

  it("writes the endpoints the modules declared for /auth/establish", () => {
    const source = mkdtempSync(join(tmpdir(), "dms-establish-module-"));
    const workspace = mkdtempSync(join(tmpdir(), "dms-establish-workspace-"));
    writeFrontendModuleRegistry(workspace, [
      {
        path: source,
        packageName: "@dms/saas",
        priority: 0,
        authEstablishEndpoints: ["/api/saas/register/finalize"],
      },
      {
        path: source,
        packageName: "@dms/invites",
        priority: 1,
        authEstablishEndpoints: [
          "/api/invites/redeem",
          "/api/saas/register/finalize",
        ],
      },
    ]);
    const declared = JSON.parse(
      readFileSync(join(workspace, "generated-auth-establish.json"), "utf8"),
    );
    assert.deepEqual(declared.endpoints, [
      "/api/saas/register/finalize",
      "/api/invites/redeem",
    ]);
  });

  it("writes an empty declaration for a manifest that carries none", () => {
    const source = mkdtempSync(join(tmpdir(), "dms-establish-none-module-"));
    const workspace = mkdtempSync(join(tmpdir(), "dms-establish-none-"));
    writeFrontendModuleRegistry(workspace, [
      { path: source, packageName: "@dms/legacy", priority: 0 },
    ]);
    const declared = JSON.parse(
      readFileSync(join(workspace, "generated-auth-establish.json"), "utf8"),
    );
    assert.deepEqual(declared.endpoints, []);
  });

  it("writes the public endpoints the modules declare for the server", () => {
    const source = mkdtempSync(join(tmpdir(), "dms-public-module-"));
    const workspace = mkdtempSync(join(tmpdir(), "dms-public-workspace-"));
    const webhook = {
      path: "/api/mailing/events/*/*",
      headers: ["x-mailing-webhook-secret"],
    };
    writeFrontendModuleRegistry(workspace, [
      {
        path: source,
        packageName: "@dms/mailing",
        priority: 0,
        publicEndpoints: [webhook, "not-an-object" as never],
      },
      { path: source, packageName: "@dms/legacy", priority: 1 },
    ]);
    const declared = JSON.parse(
      readFileSync(join(workspace, "generated-public-endpoints.json"), "utf8"),
    );
    assert.deepEqual(declared.endpoints, [webhook]);
  });

  it("drops malformed declared endpoints instead of materializing them", () => {
    assert.deepEqual(
      collectAuthEstablishEndpoints([
        {
          path: "/tmp/module",
          packageName: "@dms/bad",
          authEstablishEndpoints: [
            "/api/ok",
            "/auth/login",
            "/api/../secret",
            "http://evil.test/api/x",
            "/api/ok?token=1",
          ],
        },
      ]),
      ["/api/ok"],
    );
  });

  it("ships complete renderer-specific workspace templates", () => {
    const vuePackage = readFileSync(
      join("templates", "vue", "package.json"),
      "utf8",
    );
    assert.match(vuePackage, /@inertiajs\/vue3/);
  });
  it("preserves deterministic manifest priority in the module registry", () => {
    const first = mkdtempSync(join(tmpdir(), "dms-module-"));
    const second = mkdtempSync(join(tmpdir(), "dms-module-"));
    mkdirSync(first, { recursive: true });
    writeFileSync(join(first, "dms.frontend.ts"), "export default {};");
    const registry = createFrontendModuleRegistry("/workspace", [
      { path: second, packageName: "@dms/zebra", priority: 10 },
      {
        path: first,
        packageName: "@dms/alpha",
        priority: 10,
        configKey: "dms",
        options: { theme: "dark" },
      },
      { path: "/b", packageName: "@dms/low", priority: 1 },
    ]);
    assert.deepEqual(
      registry.modules.map((module) => [module.id, module.priority]),
      [
        ["dms__alpha", 10],
        ["dms__zebra", 10],
        ["dms__low", 1],
      ],
    );
    assert.equal(registry.modules[0].entry, "dms.frontend.ts");
    assert.equal(registry.modules[1].entry, undefined);
    assert.deepEqual(registry.modules[0].options, {
      dms: { theme: "dark" },
    });
  });

  it("gives higher-priority modules ownership of generated assets and aliases", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-workspace-"));
    const highSource = mkdtempSync(join(tmpdir(), "dms-module-"));
    const lowSource = mkdtempSync(join(tmpdir(), "dms-module-"));
    const modulesRoot = join(workspace, "frontend-modules");
    const highRoot = join(modulesRoot, "dms__high", "layers", "shared");
    const lowRoot = join(modulesRoot, "dms__low", "layers", "shared");
    for (const [root, label] of [
      [highRoot, "high"],
      [lowRoot, "low"],
    ]) {
      mkdirSync(join(root, "public", "images"), { recursive: true });
      mkdirSync(join(root, "i18n", "locales"), { recursive: true });
      writeFileSync(join(root, "public", "images", "logo.svg"), label);
      writeFileSync(
        join(root, "i18n", "locales", "shared-en-GB.json"),
        JSON.stringify({ owner: label }),
      );
    }
    writeFrontendModuleRegistry(workspace, [
      { path: lowSource, packageName: "@dms/low", priority: 1 },
      { path: highSource, packageName: "@dms/high", priority: 10 },
    ]);
    assert.equal(
      readFileSync(join(workspace, "public", "images", "logo.svg"), "utf8"),
      "high",
    );
    const paths = JSON.parse(
      readFileSync(join(workspace, "frontend-paths.generated.json"), "utf8"),
    );
    assert.deepEqual(paths.compilerOptions.paths["#shared/*"], [
      "./frontend-modules/dms__high/layers/shared/*",
    ]);
    assert.match(
      readFileSync(join(workspace, "locales.generated", "en.ts"), "utf8"),
      /"owner":"high"/,
    );
  });

  it("keeps dev-rewritten declaration files, build output and translation catalogs out of Tailwind's source scan", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-gitignore-workspace-"));
    copyStaticTemplates(workspace);
    const ignored = readFileSync(join(workspace, ".gitignore"), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    assert.deepEqual(ignored.sort(), [
      "auto-imports.d.ts",
      "components.d.ts",
      "dist/",
      "frontend-modules/**/i18n/locales/",
      "locales.generated/",
    ]);
  });
});

// A path a Node API opens keeps its native separators; a path that becomes
// text in generated output must not. Windows is the only platform where the
// two differ, so the separator is injected explicitly here rather than taken
// from the host.
describe("Windows path separators in generated output", () => {
  it("rewrites a native Windows path onto POSIX separators", () => {
    assert.equal(
      toPosixPath("C:\\workspace\\frontend-modules\\dms__ai", "\\"),
      "C:/workspace/frontend-modules/dms__ai",
    );
  });

  it("leaves a POSIX path alone, backslashes in filenames included", () => {
    // A backslash is a legal character in a POSIX name, so the rewrite is
    // conditioned on the platform separator rather than applied blindly.
    for (const path of [
      "/home/dev/workspace/frontend-modules/dms__ai",
      "/srv/od\\d name/app",
    ]) {
      assert.equal(toPosixPath(path, "/"), path);
      assert.equal(toPosixPath(path), path);
    }
  });

  it("writes every Tailwind @source as a POSIX glob", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-main-css-"));
    writeDmsMainCss(workspace, [
      { path: "/src/ai", packageName: "@dms/ai", priority: 1 },
      { path: "/src/saas", packageName: "@dms/saas", priority: 0 },
    ]);
    const sources = [
      ...readFileSync(join(workspace, "dms-main.css"), "utf8").matchAll(
        /@source "([^"]+)";/g,
      ),
    ].map((match) => match[1]);
    assert.equal(sources.length, 2);
    for (const source of sources) {
      assert.doesNotMatch(
        source,
        /\\/,
        "Tailwind reads a backslash in @source as an escape, not a separator",
      );
      assert.ok(source.endsWith("/**/*.{vue,ts,tsx,js,jsx,mjs,cjs}"));
      assert.ok(
        source.startsWith(`${toPosixPath(resolve(workspace))}/`),
        "the scan must stay inside the workspace copy of each module",
      );
    }
  });
});
