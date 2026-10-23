import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

interface ManifestEntry {
  css?: string[];
  file?: string;
  isDynamicEntry?: boolean;
}

const COMPONENTS = "frontend-modules/fixture";

/**
 * Three lazily loaded components, each with a stylesheet of its own, loaded
 * the way a DMS module loads its components: one glob of loaders, each
 * registered as an async component. The page is the one its props name; the
 * child is only rendered from the page's template; the third is registered
 * and never rendered.
 */
const FILES: Record<string, string> = {
  [`${COMPONENTS}/Page.vue`]: `<template><main class="fixture-page"><FixtureChild /></main></template>
<style>.fixture-page { display: grid; }</style>
`,
  [`${COMPONENTS}/Child.vue`]: `<template><div class="fixture-child">child rendered</div></template>
<style>.fixture-child { position: absolute; }</style>
`,
  [`${COMPONENTS}/Unused.vue`]: `<template><div class="fixture-unused">unused</div></template>
<style>.fixture-unused { position: fixed; }</style>
`,
  "frontend-modules.generated.ts": `
import { defineAsyncComponent } from "vue";
const loaders = import.meta.glob("./${COMPONENTS}/*.vue");
const lazy = (name) => defineAsyncComponent(async () => (await loaders["./${COMPONENTS}/" + name + ".vue"]()).default);
export const frontendModules = [{ options: { public: {} }, module: { setup(sdk) {
  sdk.registerPage("page", lazy("Page"));
  sdk.registerComponent("FixtureChild", lazy("Child"));
  sdk.registerComponent("FixtureUnused", lazy("Unused"));
} } }];
`,
  // The client build only needs to split the components the way the real
  // entry does: one dynamic entry, with its stylesheet, per component.
  // and one file per locale catalog, as the generated locale module loads them.
  "client-fixture.ts": `globalThis.fixtureLoaders = import.meta.glob("./${COMPONENTS}/*.vue");\nglobalThis.fixtureCatalog = () => import("./locales.generated/en.ts");\n`,
  "locales.generated/en.ts": "export default {};\n",
  "ui-stub.ts": `import {h} from 'vue'; const appConfig={}; export const useAppConfig=()=>appConfig;export const useToast=()=>({add(){}});export const en={code:"en"};export const fr={code:"fr"};export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};`,
  "package.json": '{"type":"module"}',
  "frontend-paths.generated.json": "{}",
  "generated-frontend-modules.json": '{"modules":[]}',
  "app-configs.generated.ts": "export const appConfigs = [];\n",
  "locales.generated.ts":
    'export const localeMessages={en:{}};export const supportedLocales=["en"];export const catalogLocale=(locale)=>locale.slice(0,2);export const loadLocaleMessages=async()=>({});export const syncLocaleMessages=()=>{};',
};

function write(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function viteBuild(workspace: string, config: string): void {
  execFileSync(
    process.execPath,
    [
      resolve("node_modules/vite/bin/vite.js"),
      "build",
      "--config",
      config,
      "--logLevel",
      "error",
    ],
    { cwd: workspace, stdio: "pipe" },
  );
}

/** The built stylesheet of a component, from the client manifest. */
function componentStylesheet(
  manifest: Record<string, ManifestEntry>,
  name: string,
): string {
  const entry = manifest[`${COMPONENTS}/${name}.vue`];
  assert.ok(entry?.isDynamicEntry, `${name}.vue is a lazily loaded chunk`);
  assert.equal(entry.css?.length, 1, `${name}.vue has a stylesheet`);
  return entry.css[0];
}

function linkedStylesheets(html: string): string[] {
  const head = html.slice(0, html.indexOf("</head>"));
  return [...head.matchAll(/<link rel="stylesheet" href="\/([^"]+)">/g)].map(
    ([, file]) => file,
  );
}

it("links the stylesheet of every component the server rendered, and only those", async () => {
  const workspace = mkdtempSync(resolve(".ssr-component-styles-"));
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backend = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture").searchParams.get(
      "path",
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ componentName: path?.slice(1) }));
  });
  let frontend: ReturnType<typeof createServer> | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    for (const [path, content] of Object.entries(FILES))
      write(workspace, path, content);
    const uiStub = JSON.stringify(join(workspace, "ui-stub.ts"));
    write(
      workspace,
      "vite.fixture-client.config.mjs",
      `import vue from '@vitejs/plugin-vue';
export default {plugins:[vue()],build:{manifest:true,outDir:'dist/client',rollupOptions:{input:'client-fixture.ts'}}};`,
    );
    write(
      workspace,
      "vite.fixture-ssr.config.mjs",
      `import vue from '@vitejs/plugin-vue';
export default {plugins:[{name:'fixture-ui',resolveId(id){if(id.startsWith('@nuxt/ui/'))return ${uiStub}}},vue()],build:{ssr:'ssr-renderer.ts',outDir:'dist/ssr'}};`,
    );
    viteBuild(workspace, "vite.fixture-client.config.mjs");
    viteBuild(workspace, "vite.fixture-ssr.config.mjs");
    write(
      workspace,
      "dist/client/index.html",
      "<html><head><title>Antelope DMS</title></head><body>__DMS_APP__</body></html>",
    );
    const manifest = JSON.parse(
      readFileSync(join(workspace, "dist/client/.vite/manifest.json"), "utf8"),
    ) as Record<string, ManifestEntry>;
    const page = componentStylesheet(manifest, "Page");
    const child = componentStylesheet(manifest, "Child");
    const unused = componentStylesheet(manifest, "Unused");

    await new Promise<void>((settle) => backend.listen(0, "127.0.0.1", settle));
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const { handleRequestSafely } = await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    );
    frontend = createServer(handleRequestSafely);
    await new Promise<void>((settle) =>
      frontend!.listen(0, "127.0.0.1", settle),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/page`, {
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /class="fixture-child">child rendered</);
    assert.doesNotMatch(html, /fixture-unused/);

    const linked = linkedStylesheets(html);
    assert.ok(linked.includes(page), "the page's stylesheet is linked");
    assert.ok(
      linked.includes(child),
      "the stylesheet of the component the page's template rendered is linked",
    );
    assert.ok(
      !linked.includes(unused),
      "a component the render never reached gets no link",
    );
    assert.equal(new Set(linked).size, linked.length, "each link once");

    // The catalog of the page's locale is preloaded next to the entry, not
    // requested once the entry runs.
    const catalog = manifest["locales.generated/en.ts"];
    assert.ok(catalog?.isDynamicEntry, "the catalog is a file of its own");
    const head = html.slice(0, html.indexOf("</head>"));
    assert.ok(
      head.includes(
        `<link rel="modulepreload" crossorigin href="/${catalog.file}">`,
      ),
      "the catalog of the page's locale is preloaded",
    );
  } finally {
    frontend?.closeAllConnections();
    await Promise.all(
      [frontend, backend].map(
        (server) =>
          new Promise<void>((settle) =>
            server?.listening ? server.close(() => settle()) : settle(),
          ),
      ),
    );
    if (previousBackend === undefined) delete process.env.DMS_API_BASE_URL;
    else process.env.DMS_API_BASE_URL = previousBackend;
    rmSync(workspace, { recursive: true, force: true });
  }
});
