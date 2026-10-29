import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { parse } from "devalue";

/**
 * The pages render through the real SSR entry: the payload the browser
 * hydrates with is only what the HTML of the same render shows.
 */
const FIXTURE_MODULES = `
import {defineComponent,h} from 'vue';
import {Icon,addIcon} from '@iconify/vue';
import {$fetch,createDmsError,defineDmsPageMeta,useDmsAsyncData,useDmsState} from './frontend-module';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
export const frontendModules=[{options:{public:{}},module:{setup(sdk){
 addIcon('fixture:dot',{body:'<circle cx="1" cy="1" r="1"/>',width:2,height:2});
 sdk.registerPlugin(async()=>{const {data,refresh}=useDmsAsyncData('plugin-key',()=>$fetch('/plugin-data'),{lazy:true});if(!data.value)await refresh()});
 sdk.registerMiddleware('guard-data',async to=>{if(to.path!=='/guarded')return;await sleep(5);useDmsState('guard-state',()=>undefined,{transfer:true}).value='set by the guard';await useDmsAsyncData('guard-key',async()=>'loaded by the guard')},{global:true});
 const Lazy=defineComponent({setup(){const {data,status}=useDmsAsyncData('lazy-key',async()=>{await sleep(1);return 'fresh'},{lazy:true});return()=>h('p','lazy '+status.value+':'+data.value)}});
 const Slow=defineComponent({async setup(){await sleep(30);return()=>h('p','slow sibling')}});
 sdk.registerPage('lazy',defineComponent({setup(){return()=>h('div',[h(Lazy),h(Slow)])}}));
 const GuardedContent=defineComponent({setup(){const state=useDmsState('guard-state');const {data}=useDmsAsyncData('guard-key',async()=>'loaded again');return()=>h('p','content:'+state.value+':'+data.value)}});
 sdk.registerPage('guarded',defineComponent({setup(){defineDmsPageMeta({});const state=useDmsState('guard-state');return()=>h('div',[h('p','page:'+state.value),h(GuardedContent)])}}));
 sdk.registerPage('client-only',defineComponent({setup(){const {data,status}=useDmsAsyncData('client-key',()=>$fetch('/client-data'),{server:false,default:()=>'default'});return()=>h('p','client '+status.value+':'+data.value)}}));
 sdk.registerPage('plugin',defineComponent({setup(){const {data}=useDmsAsyncData('plugin-key',()=>$fetch('/plugin-data'),{lazy:true});return()=>h('p','plugin:'+data.value)}}));
 sdk.registerPage('payload',defineComponent({setup(){
  const seen=useDmsState('seen',()=>new Set(['a','b']),{transfer:true});
  useDmsState('since',()=>new Date('2026-10-02T00:00:00.000Z'),{transfer:true});
  useDmsState('closing',()=>'</script><script>alert(1)</script>',{transfer:true});
  useDmsState('server-only',()=>'private-value');
  useDmsState('instance',()=>new (class Box{value=1})(),{transfer:true});
  const {status}=useDmsAsyncData('missing',async()=>{throw createDmsError({statusCode:404,statusMessage:'Not Found',data:'orders.not_found'})});
  return()=>h('p',['payload '+status.value+':'+seen.value.size,h(Icon,{icon:'fixture:dot'})])}}));
}}}];`;

interface Payload {
  data: Record<string, unknown>;
  errors: Record<string, unknown>;
  state: Record<string, unknown>;
}

function serverPayload(html: string): Payload {
  const match = html.match(
    /<script id="dms-payload" type="application\/json">(.*?)<\/script>/s,
  );
  assert.ok(match, "every server render carries its payload");
  return parse(match[1]) as Payload;
}

function payload(html: string): Record<string, unknown> {
  return serverPayload(html).data;
}

it("hydrates a server render with exactly the data its HTML shows", async (context) => {
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
      join(workspace, "app-configs.generated.ts"),
      "export const appConfigs = [];\n",
    );
    writeFileSync(
      join(workspace, "locales.generated.ts"),
      'export const localeMessages={en:{},fr:{}};export const supportedLocales=["en","fr"];export const catalogLocale=(locale)=>locale.slice(0,2);export const loadLocaleMessages=async()=>({});export const syncLocaleMessages=()=>{};',
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

    const lazy = await render("/lazy");
    assert.match(lazy, /lazy success:fresh/);
    assert.equal(payload(lazy)["lazy-key"], "fresh");

    const guarded = await render("/guarded");
    assert.match(guarded, /page:set by the guard/);
    assert.match(guarded, /content:set by the guard:loaded by the guard/);
    assert.equal(
      serverPayload(guarded).state["guard-state"],
      "set by the guard",
    );
    assert.equal(payload(guarded)["guard-key"], "loaded by the guard");

    backendCalls.length = 0;
    const clientOnly = await render("/client-only");
    assert.match(clientOnly, /client idle:default/);
    assert.equal("client-key" in payload(clientOnly), false);
    assert.equal(backendCalls.includes("/client-data"), false);

    backendCalls.length = 0;
    const plugin = await render("/plugin");
    assert.match(plugin, /plugin:backend \/plugin-data/);
    assert.equal(payload(plugin)["plugin-key"], "backend /plugin-data");
    assert.deepEqual(
      backendCalls.filter((path) => path === "/plugin-data"),
      ["/plugin-data"],
    );

    const logged = context.mock.method(console, "error", () => {});
    const page = await render("/payload");
    logged.mock.restore();
    assert.match(page, /payload error:2/);
    assert.match(page, /<circle cx="1" cy="1" r="1"/);
    const icons = page.match(
      /<script id="dms-ssr-icons" type="application\/json">(.*?)<\/script>/s,
    );
    assert.ok(icons, "the icons script follows the payload");
    assert.deepEqual(Object.keys(JSON.parse(icons[1])), ["fixture:dot"]);
    assert.doesNotMatch(page, /dms-ssr-async-data/);
    assert.doesNotMatch(page, /<\/script><script>alert/);
    assert.doesNotMatch(page, /private-value/);
    const transferred = serverPayload(page);
    assert.deepEqual(transferred.state.seen, new Set(["a", "b"]));
    assert.deepEqual(
      transferred.state.since,
      new Date("2026-10-02T00:00:00.000Z"),
    );
    assert.equal(
      transferred.state.closing,
      "</script><script>alert(1)</script>",
    );
    assert.deepEqual(transferred.errors.missing, {
      statusCode: 404,
      statusMessage: "Not Found",
      message: "Not Found",
      data: "orders.not_found",
    });
    assert.equal("instance" in transferred.state, false);
    assert.ok(
      logged.mock.calls.some((call) =>
        String(call.arguments[0]).includes('"instance" cannot be serialized'),
      ),
    );
  } finally {
    frontend?.close();
    backend.close();
    if (previousBackend === undefined) delete process.env.DMS_API_BASE_URL;
    else process.env.DMS_API_BASE_URL = previousBackend;
    rmSync(workspace, { recursive: true, force: true });
  }
});
