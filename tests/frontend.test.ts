import * as assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
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
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { readText } from "./helpers/files";
import { jsonAt, readJson } from "./helpers/json";

describe("Vite frontend generation", () => {
  it("discovers Vue entries and the stable SDK alias", () => {
    const source = temporaryDirectory("dms-vue-module-");
    const workspace = temporaryDirectory("dms-vue-workspace-");
    writeFileSync(join(source, "dms.frontend.ts"), "export default {};");
    const registry = createFrontendModuleRegistry(workspace, [
      { path: source, packageName: "@dms/vue", priority: 7 },
    ]);
    assert.equal(registry.modules[0].entry, "dms.frontend.ts");
    writeFrontendModuleRegistry(workspace, [
      { path: source, packageName: "@dms/vue", priority: 7 },
    ]);
    const paths = readText(join(workspace, "frontend-paths.generated.json"));
    const loader = readText(join(workspace, "frontend-modules.generated.ts"));
    assert.match(paths, /#dms\/frontend-module/);
    assert.match(loader, /dms\.frontend\.ts/);
  });

  it("writes the endpoints the modules declared for /auth/establish", () => {
    const source = temporaryDirectory("dms-establish-module-");
    const workspace = temporaryDirectory("dms-establish-workspace-");
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
    const declared = readJson(join(workspace, "generated-auth-establish.json"));
    assert.deepEqual(jsonAt(declared, "endpoints"), [
      "/api/saas/register/finalize",
      "/api/invites/redeem",
    ]);
  });

  it("writes an empty declaration for a manifest that carries none", () => {
    const source = temporaryDirectory("dms-establish-none-module-");
    const workspace = temporaryDirectory("dms-establish-none-");
    writeFrontendModuleRegistry(workspace, [
      { path: source, packageName: "@dms/legacy", priority: 0 },
    ]);
    const declared = readJson(join(workspace, "generated-auth-establish.json"));
    assert.deepEqual(jsonAt(declared, "endpoints"), []);
  });

  it("writes the public endpoints the modules declare for the server", () => {
    const source = temporaryDirectory("dms-public-module-");
    const workspace = temporaryDirectory("dms-public-workspace-");
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
    const declared = readJson(
      join(workspace, "generated-public-endpoints.json"),
    );
    assert.deepEqual(jsonAt(declared, "endpoints"), [webhook]);
    assert.deepEqual(jsonAt(declared, "proxies"), []);
  });

  it("writes the backend proxies the modules declare, with the module that declared each", () => {
    const source = temporaryDirectory("dms-proxies-module-");
    const workspace = temporaryDirectory("dms-proxies-workspace-");
    writeFrontendModuleRegistry(workspace, [
      {
        path: source,
        name: "@dms/media",
        packageName: "@dms/media",
        priority: 0,
        backendProxies: [
          { path: "/media/**", auth: "none" },
          "not-an-object" as never,
        ],
      },
    ]);
    const declared = readJson(
      join(workspace, "generated-public-endpoints.json"),
    );
    assert.deepEqual(jsonAt(declared, "proxies"), [
      { path: "/media/**", auth: "none", module: "@dms/media" },
    ]);
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

  it("preserves deterministic manifest priority in the module registry", () => {
    const first = temporaryDirectory("dms-module-");
    const second = temporaryDirectory("dms-module-");
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
    const workspace = temporaryDirectory("dms-workspace-");
    const highSource = temporaryDirectory("dms-module-");
    const lowSource = temporaryDirectory("dms-module-");
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
      readText(join(workspace, "public", "images", "logo.svg")),
      "high",
    );
    const paths = readJson(join(workspace, "frontend-paths.generated.json"));
    assert.deepEqual(jsonAt(paths, "compilerOptions", "paths", "#shared/*"), [
      "./frontend-modules/dms__high/layers/shared/*",
    ]);
    assert.match(
      readText(join(workspace, "locales.generated", "en.ts")),
      /"owner":"high"/,
    );
  });

  it("keeps dev-rewritten declaration files, build output and translation catalogs out of Tailwind's source scan", () => {
    const workspace = temporaryDirectory("dms-gitignore-workspace-");
    copyStaticTemplates(workspace);
    const ignored = readText(join(workspace, ".gitignore"))
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    assert.deepEqual(ignored.sort(), [
      "auto-imports.d.ts",
      "components.d.ts",
      "dist/",
      "frontend-modules/**/i18n/locales/",
      "locales.generated/",
      "sfc-global-types.generated.d.ts",
    ]);
  });
});

describe("Windows path separators in generated output", () => {
  it("rewrites a native Windows path onto POSIX separators", () => {
    assert.equal(
      toPosixPath("C:\\workspace\\frontend-modules\\dms__ai", "\\"),
      "C:/workspace/frontend-modules/dms__ai",
    );
  });

  it("leaves a POSIX path alone, backslashes in filenames included", () => {
    for (const path of [
      "/home/dev/workspace/frontend-modules/dms__ai",
      "/srv/od\\d name/app",
    ]) {
      assert.equal(toPosixPath(path, "/"), path);
      assert.equal(toPosixPath(path), path);
    }
  });

  it("writes every Tailwind @source as a POSIX glob", () => {
    const workspace = temporaryDirectory("dms-main-css-");
    writeDmsMainCss(workspace, [
      { path: "/src/ai", packageName: "@dms/ai", priority: 1 },
      { path: "/src/saas", packageName: "@dms/saas", priority: 0 },
    ]);
    const sources = [
      ...readText(join(workspace, "dms-main.css")).matchAll(
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
