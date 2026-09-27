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

  it("uses the official Nuxt UI Vite and Inertia plugins", () => {
    const config = readFileSync(
      join("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    const pkg = readFileSync(join("templates", "vue", "package.json"), "utf8");
    assert.match(pkg, /"@inertiajs\/vue3": "\^3\.7\.0"/);
    assert.match(config, /from "@nuxt\/ui\/vite"/);
    assert.match(config, /ui\(\{[\s\S]*router: "inertia"/);
    assert.match(config, /dms-ui-inertia-link/);
    assert.match(
      config,
      /@nuxt\/ui\/dist\/runtime\/vue\/overrides\/inertia\/Link\.vue/,
    );
    const runtime = readFileSync(
      join("templates", "vue", "app-runtime.ts"),
      "utf8",
    );
    assert.match(runtime, /from "@nuxt\/ui\/vue-plugin"/);
  });

  it("copies the email renderer required by the production build", () => {
    assert.equal(
      readFileSync(join("templates", "vue", "email-renderer.ts"), "utf8")
        .length > 0,
      true,
    );
    const emailConfig = readFileSync(
      join("templates", "vue", "vite.email.config.ts"),
      "utf8",
    );
    assert.match(emailConfig, /dts: false/);
    assert.match(emailConfig, /"useDmsAppConfig"/);
    assert.match(emailConfig, /"useDmsRuntimeConfig"/);
  });

  it("keeps SSR visible during bootstrap and hydrates layout state from Inertia", () => {
    const packageTemplate = readFileSync(
      join("templates", "vue", "package.json"),
      "utf8",
    );
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    const appRuntime = readFileSync(
      join("templates", "vue", "app-runtime.ts"),
      "utf8",
    );
    const html = readFileSync(join("templates", "vue", "index.html"), "utf8");
    const main = readFileSync(join("templates", "vue", "main.ts"), "utf8");
    assert.match(packageTemplate, /node compress-assets\.mjs/);
    const renderedHtml = html.replace(
      "__DMS_APP__",
      '<main id="app" data-server-rendered="true">Server content</main>',
    );
    assert.doesNotMatch(renderedHtml, /dms-pre-hydration-guard/);
    assert.doesNotMatch(renderedHtml, /#app\s*\{[^}]*visibility\s*:\s*hidden/);
    assert.match(renderedHtml, />Server content<\/main>/);
    assert.doesNotMatch(main, /PRE_HYDRATION_GUARD_ID|getElementById/);
    assert.match(main, /dataset\.dmsReady = "true"/);
    assert.match(main, /markDmsReady\(\)/);
    assert.match(runtime, /export function hydrateDmsPageProps/);
    assert.match(runtime, /export async function preloadComponents/);
    assert.match(appRuntime, /hydrateDmsPageProps\(props\.value\)/);
    assert.match(appRuntime, /defu\(useDmsAppConfig\(\), uiAppConfig\)/);
    assert.match(appRuntime, /preloadDmsPage\(props\.value\)/);
    assert.match(appRuntime, /component\("Icon", UIcon\)/);
    assert.match(appRuntime, /getDmsLayoutProps\(props\)/);
    assert.match(appRuntime, /layout: DmsPersistentLayout/);
    assert.match(appRuntime, /return DmsPersistentInertiaPage/);
    assert.match(appRuntime, /DmsPersistentLayout[\s\S]*hydrateDmsPageProps/);
    assert.match(appRuntime, /default: \(\) => children/);
    assert.doesNotMatch(appRuntime, /default: \(\) => content/);
  });

  it("replaces a failed Inertia page slot with the captured error page", () => {
    const appRuntime = readFileSync(
      join("templates", "vue", "app-runtime.ts"),
      "utf8",
    );
    assert.match(
      appRuntime,
      /const content = error\s*\? \[renderDmsPage\(props\.value, error\)\]\s*:\s*slots\.default\?\.\(\)/,
    );
  });

  it("runs middleware around native Inertia links and prefetches on hover", () => {
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    assert.match(runtime, /event\.preventDefault\(\)/);
    assert.match(runtime, /void visit\(runtime, props\.to/);
    assert.match(runtime, /prefetch: prefetch \?\? "hover"/);
  });

  it("loads modules and renders backend component definitions recursively", () => {
    const main = readFileSync(join("templates", "vue", "main.ts"), "utf8");
    const appRuntime = readFileSync(
      join("templates", "vue", "app-runtime.ts"),
      "utf8",
    );
    const page = readFileSync(
      join("templates", "vue", "DmsDynamicPage.vue"),
      "utf8",
    );
    assert.match(main, /setupFrontendModules\(frontendModules\)/);
    assert.match(appRuntime, /getDmsPage\(props\) \?\? DmsDynamicPage/);
    assert.match(page, /resolveDmsComponent/);
    assert.match(page, /<DmsRecursiveComponent/);
    assert.match(
      page,
      /const \{ id: childId, component, \.\.\.childPlacement \} = child/,
    );
    assert.doesNotMatch(
      page,
      /resolveDefinition\(child\.id, child\.component, child\)/,
    );
  });

  it("awaits explicitly registered plugins in module order", () => {
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    assert.match(runtime, /for \(const registration of pluginSetups\)/);
    assert.match(
      runtime,
      /await runtime\.scope\.run\(\(\) =>\s*app\.runWithContext/,
    );
    const appRuntime = readFileSync(
      join("templates", "vue", "app-runtime.ts"),
      "utf8",
    );
    assert.match(
      appRuntime,
      /const mounted = await installDmsPlugins\([\s\S]*runtime,[\s\S]*loadLocaleMessages/,
    );
    assert.match(appRuntime, /return \{ mounted, runtime \}/);
  });

  it("keeps higher-priority ownership across runtime registries", () => {
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    const viteConfig = readFileSync(
      join("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    assert.match(runtime, /if \(!namedMiddleware\.has\(name\)\)/);
    assert.match(runtime, /if \(!injections\.has\(key\)\)/);
    assert.match(
      runtime,
      /defu\(\s*runtimeConfig\.value\.public,\s*registration\.options\.public/,
    );
    assert.match(
      viteConfig,
      /\[\.\.\.registry\.modules\]\.reverse\(\)\.flatMap/,
    );
    // The layer aliases go through `frontendLayerTypePaths`, which gives a
    // contested name to the last root, so the reversal is what hands it to
    // the highest-priority module.
    assert.match(
      readFileSync(join("src", "materialize.ts"), "utf8"),
      /\[\.\.\.registry\.modules\]\.reverse\(\)\.map/,
    );
  });

  it("keeps custom pages, dynamic pages, and layouts in separate registries", () => {
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    const appRuntime = readFileSync(
      join("templates", "vue", "app-runtime.ts"),
      "utf8",
    );
    assert.match(runtime, /const dynamicPages = new Map/);
    assert.match(runtime, /const layouts = new Map/);
    assert.doesNotMatch(runtime, /props\.path, "default"/);
    assert.match(runtime, /if \(props\.error\) return errorPage/);
    assert.match(appRuntime, /getDmsLayout\(props\)/);
  });

  it("builds and hydrates the same Inertia Vue tree with SSR", () => {
    const packageTemplate = readFileSync(
      join("templates", "vue", "package.json"),
      "utf8",
    );
    const main = readFileSync(join("templates", "vue", "main.ts"), "utf8");
    const renderer = readFileSync(
      join("templates", "vue", "ssr-renderer.ts"),
      "utf8",
    );
    assert.match(packageTemplate, /vite build --ssr ssr-renderer\.ts/);
    assert.match(main, /el\.hasAttribute\("data-server-rendered"\)/);
    assert.match(main, /\? createSSRApp\(root\)/);
    assert.match(main, /: createApp\(root\)/);
    assert.match(main, /resolve: resolveDmsInertiaPage/);
    assert.ok(
      main.indexOf('dataset.dmsReady = "true"') <
        main.indexOf("await configured.mounted()"),
    );
    assert.match(
      renderer,
      /render: \(app\) => renderToString\(app, ssrContext\)/,
    );
    assert.match(renderer, /resolve: resolveDmsInertiaPage/);
    assert.match(renderer, /teleports\?\.\["#dms-overlays"\]/);
  });

  it("normalizes page registration and lookup keys around URLs", () => {
    const normalize = (name: string) =>
      name.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, "");
    for (const path of [
      "auth/login",
      "/auth/login",
      "/auth/login/",
      "/auth/login?next=%2F",
    ])
      assert.equal(normalize(path), "auth/login");
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    assert.match(runtime, /pages\.has\(normalizeDmsPageKey\(candidate\)\)/);
    assert.match(runtime, /return pages\.has\(normalizeDmsPageKey\(name\)\)/);
    assert.match(runtime, /const key = normalizeDmsPageKey\(name\)/);
    assert.match(runtime, /dynamicPages\.get\(CATCH_ALL_PAGE_KEY\)/);
    assert.match(runtime, /const CATCH_ALL_PAGE_KEY = "\[\.\.\.slug\]"/);
  });

  it("normalizes backend component aliases", () => {
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    assert.match(runtime, /replace\(\/\^lazy\/i/);
    assert.match(runtime, /replace\(\/\^dms\[-_\]\?\/i/);
    for (const backendName of ["dms-default-layout", "dms-empty-layout"]) {
      assert.equal(
        backendName.replace(/^dms[-_]?/i, "").replace(/[^a-z0-9]/gi, ""),
        backendName === "dms-default-layout" ? "defaultlayout" : "emptylayout",
      );
    }
  });

  it("auto-imports native DMS composables", () => {
    const config = readFileSync(
      join("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    assert.match(config, /autoImport:/);
    assert.match(config, /"app\/composables\/\*\*\/\*"/);
    assert.match(config, /dirsScanOptions: \{ types: true \}/);
    assert.match(config, /"useDmsRoute"/);
    assert.match(config, /"defineDmsPlugin"/);
    assert.doesNotMatch(config, /"#imports"/);
  });

  it("keeps dev-rewritten declaration files and build output out of Tailwind's source scan", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-gitignore-workspace-"));
    copyStaticTemplates(workspace);
    const ignored = readFileSync(join(workspace, ".gitignore"), "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    assert.deepEqual(ignored.sort(), [
      "auto-imports.d.ts",
      "components.d.ts",
      "dist/",
    ]);
  });

  it("provides explicit native runtime contracts", () => {
    const runtime = readFileSync(
      join("templates", "vue", "frontend-module.ts"),
      "utf8",
    );
    for (const contract of [
      "useDmsState",
      "useDmsRuntimeConfig",
      "useDmsRoute",
      "useDmsRouter",
      "useDmsFetch",
      "useDmsCookie",
      "showError",
      "useHead",
      "useI18n",
      "useDmsApp",
    ]) {
      assert.match(
        runtime,
        new RegExp(`export (?:function|const) ${contract}`),
      );
    }
    assert.match(runtime, /options: DmsModuleOptions/);
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
