import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

// The pages render through the real SSR entry: the payload the browser
// hydrates with is only what the HTML of the same render shows.
const FIXTURE_MODULES = `
import {defineComponent,h} from 'vue';
import {$fetch,defineDmsPageMeta,useDmsAsyncData,useDmsLazyAsyncData} from './frontend-module';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
export const frontendModules=[{options:{public:{}},module:{setup(sdk){
 sdk.registerPlugin(async()=>{const {data,refresh}=useDmsLazyAsyncData('plugin-key',()=>$fetch('/plugin-data'));if(!data.value)await refresh()});
 sdk.registerMiddleware('late-data',async to=>{if(to.path!=='/late')return;await sleep(5);await useDmsAsyncData('late-key',async()=>'never rendered')},{global:true});
 const Lazy=defineComponent({setup(){const {data,status}=useDmsLazyAsyncData('lazy-key',async()=>{await sleep(1);return 'fresh'});return()=>h('p','lazy '+status.value+':'+data.value)}});
 const Slow=defineComponent({async setup(){await sleep(30);return()=>h('p','slow sibling')}});
 sdk.registerPage('lazy',defineComponent({setup(){return()=>h('div',[h(Lazy),h(Slow)])}}));
 sdk.registerPage('late',defineComponent({setup(){defineDmsPageMeta({});return()=>h('p','late page')}}));
 sdk.registerPage('client-only',defineComponent({setup(){const {data,status}=useDmsAsyncData('client-key',()=>$fetch('/client-data'),{server:false,default:()=>'default'});return()=>h('p','client '+status.value+':'+data.value)}}));
 sdk.registerPage('plugin',defineComponent({setup(){const {data}=useDmsLazyAsyncData('plugin-key',()=>$fetch('/plugin-data'));return()=>h('p','plugin:'+data.value)}}));
}}}];`;

function payload(html: string): Record<string, unknown> {
  const match = html.match(
    /<script id="dms-ssr-async-data" type="application\/json">(.*?)<\/script>/s,
  );
  assert.ok(match, "every server render carries its async data");
  return JSON.parse(match[1]) as Record<string, unknown>;
}

it("hydrates a server render with exactly the data its HTML shows", async () => {
  const workspace = mkdtempSync(resolve(".ssr-async-data-"));
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backendCalls: string[] = [];
  const backend = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    backendCalls.push(url.pathname);
    response.setHeader("content-type", "application/json");
    const path = url.searchParams.get("path");
    if (url.pathname === "/dms/page" && path) {
      response.end(JSON.stringify({ componentName: path.slice(1) }));
      return;
    }
    response.end(JSON.stringify(`backend ${url.pathname}`));
  });
  let frontend: ReturnType<typeof createServer> | undefined;
  try {
    cpSync("templates/vue", workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), '{"type":"module"}');
    writeFileSync(join(workspace, "frontend-paths.generated.json"), "{}");
    writeFileSync(
      join(workspace, "generated-frontend-modules.json"),
      '{"modules":[]}',
    );
    writeFileSync(
      join(workspace, "locales.generated.ts"),
      'export const localeMessages={en:{},fr:{}};export const supportedLocales=["en","fr"];export const loadLocaleMessages=async()=>({});export const syncLocaleMessages=()=>{};',
    );
    writeFileSync(
      join(workspace, "ui-stub.ts"),
      `import {h} from 'vue'; export const useAppConfig=()=>({});export const useToast=()=>({add(){}});export const en={code:"en"};export const fr={code:"fr"};export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};`,
    );
    writeFileSync(
      join(workspace, "frontend-modules.generated.ts"),
      FIXTURE_MODULES,
    );
    writeFileSync(
      join(workspace, "vite.fixture.config.mjs"),
      `
import vue from '@vitejs/plugin-vue';
export default {plugins:[{name:'fixture-ui',resolveId(id){if(id.startsWith('@nuxt/ui/'))return ${JSON.stringify(join(workspace, "ui-stub.ts"))}}},vue()],build:{ssr:'ssr-renderer.ts',outDir:'dist/ssr'}};`,
    );
    execFileSync(
      process.execPath,
      [
        resolve("node_modules/vite/bin/vite.js"),
        "build",
        "--config",
        "vite.fixture.config.mjs",
        "--logLevel",
        "error",
      ],
      { cwd: workspace, stdio: "pipe" },
    );
    mkdirSync(join(workspace, "dist/client/.vite"), { recursive: true });
    writeFileSync(
      join(workspace, "dist/client/index.html"),
      "<html><head><title>Antelope DMS</title></head><body>__DMS_APP__</body></html>",
    );
    writeFileSync(join(workspace, "dist/client/.vite/manifest.json"), "{}");
    await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done));
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const { handleRequestSafely } = await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    );
    frontend = createServer(handleRequestSafely);
    await new Promise<void>((done) => frontend!.listen(0, "127.0.0.1", done));
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const render = async (path: string) => {
      const response = await fetch(`${base}${path}`, {
        headers: { accept: "text/html" },
      });
      assert.equal(response.status, 200, path);
      return response.text();
    };

    // Lazy data settles while a slower sibling still renders: the HTML must
    // show it rather than its idle state, since the payload carries it.
    const lazy = await render("/lazy");
    assert.match(lazy, /lazy success:fresh/);
    assert.equal(payload(lazy)["lazy-key"], "fresh");

    // The page's middleware settles this key after the HTML is complete: the
    // browser never saw it rendered, so it must not hydrate with it.
    const late = await render("/late");
    assert.match(late, /late page/);
    assert.equal("late-key" in payload(late), false);

    backendCalls.length = 0;
    const clientOnly = await render("/client-only");
    assert.match(clientOnly, /client idle:default/);
    assert.equal("client-key" in payload(clientOnly), false);
    assert.equal(backendCalls.includes("/client-data"), false);

    // A plugin refreshes the lazy key it just declared: one request, whose
    // result the page renders.
    backendCalls.length = 0;
    const plugin = await render("/plugin");
    assert.match(plugin, /plugin:backend \/plugin-data/);
    assert.equal(payload(plugin)["plugin-key"], "backend /plugin-data");
    assert.deepEqual(
      backendCalls.filter((path) => path === "/plugin-data"),
      ["/plugin-data"],
    );
  } finally {
    frontend?.close();
    backend.close();
    if (previousBackend === undefined) delete process.env.DMS_API_BASE_URL;
    else process.env.DMS_API_BASE_URL = previousBackend;
    rmSync(workspace, { recursive: true, force: true });
  }
});
