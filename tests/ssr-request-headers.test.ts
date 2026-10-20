import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Fixture";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64) Fixture";

const FIXTURE_MODULES = `
import {defineComponent,h} from 'vue';
import {createDmsError,useDmsRequestHeader} from './frontend-module';
export const frontendModules=[{options:{public:{}},module:{setup(sdk){
 sdk.registerPage('agent',defineComponent({async setup(){
  const agent=useDmsRequestHeader('User-Agent');
  await new Promise(r=>setTimeout(r,10));
  const cookie=useDmsRequestHeader('cookie');
  const authorization=useDmsRequestHeader('authorization');
  return()=>h('p','agent='+agent+' cookie='+cookie+' authorization='+authorization)}}));
 sdk.registerPage('plain',defineComponent({setup(){return()=>h('p','plain')}}));
 sdk.registerPage('fails',defineComponent({setup(){
  if(useDmsRequestHeader('x-fixture-hint')!=='ok')throw createDmsError({statusCode:400,message:'bad hint'})},
  render:()=>h('p','fine')}));
 sdk.registerErrorPage(defineComponent({props:['error'],setup(props){
  const agent=useDmsRequestHeader('user-agent');
  return()=>h('main',{id:'error'},props.error.statusCode+' for '+agent)}}));
}}}];`;

/**
 * The production server and the real SSR entry, built with a fixture module
 * whose pages read request headers.
 */
describe("Request headers in a server render", () => {
  const workspace = mkdtempSync(resolve(".ssr-request-headers-"));
  const environment = {
    DMS_API_BASE_URL: process.env.DMS_API_BASE_URL,
    DMS_SESSION_SECRET: process.env.DMS_SESSION_SECRET,
  };
  const backend = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    response.setHeader("content-type", "application/json");
    const path = url.searchParams.get("path");
    if (path === null) {
      response.statusCode = 404;
      response.end('{"message":"Not found"}');
      return;
    }
    response.end(JSON.stringify({ componentName: path.slice(1) }));
  });
  let frontend: Server | undefined;
  let base = "";

  before(async () => {
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
      'export const localeMessages={en:{}};export const supportedLocales=["en"];export const loadLocaleMessages=async()=>({});export const syncLocaleMessages=()=>{};',
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
    await new Promise<void>((settle) => backend.listen(0, "127.0.0.1", settle));
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    process.env.DMS_SESSION_SECRET =
      "a-test-only-session-secret-of-32-characters";
    const { handleRequestSafely } = await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    );
    frontend = createServer(handleRequestSafely);
    await new Promise<void>((settle) =>
      frontend!.listen(0, "127.0.0.1", settle),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    base = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    for (const server of [frontend, backend]) {
      if (!server?.listening) continue;
      server.closeAllConnections();
      await new Promise((settle) => server.close(settle));
    }
    for (const [name, value] of Object.entries(environment))
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(workspace, { recursive: true, force: true });
  });

  const visit = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { headers: { accept: "text/html", ...headers } });

  it("renders each page from its own request's headers, and varies on them", async () => {
    const [mac, linux] = await Promise.all([
      visit("/agent", { "user-agent": MAC }),
      visit("/agent", { "user-agent": LINUX }),
    ]);
    assert.equal(mac.status, 200);
    assert.match(await mac.text(), new RegExp(`agent=${literal(MAC)} `));
    assert.match(await linux.text(), new RegExp(`agent=${literal(LINUX)} `));
    for (const response of [mac, linux])
      assert.match(response.headers.get("vary") ?? "", /\buser-agent\b/);
  });

  it("keeps the cookies and the credentials from the page", async () => {
    const response = await visit("/agent", {
      "user-agent": MAC,
      cookie: "theme=dark",
      authorization: "Bearer secret-token",
    });
    const html = await response.text();
    assert.match(html, /cookie=undefined authorization=undefined/);
    assert.doesNotMatch(html, /secret-token|theme=dark/);
    assert.doesNotMatch(
      response.headers.get("vary") ?? "",
      /authorization|cookie/i,
    );
  });

  it("varies only on what the render read", async () => {
    const response = await visit("/plain", { "user-agent": MAC });
    assert.match(await response.text(), /plain/);
    assert.equal(response.headers.get("vary"), "X-Inertia, Accept-Encoding");
  });

  it("gives the error page the request's headers, and varies on what both renders read", async () => {
    const response = await visit("/fails", { "user-agent": LINUX });
    assert.equal(response.status, 400);
    assert.match(
      await response.text(),
      new RegExp(`400 for ${literal(LINUX)}`),
    );
    const vary = response.headers.get("vary") ?? "";
    assert.match(vary, /\bx-fixture-hint\b/);
    assert.match(vary, /\buser-agent\b/);
  });
});

function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
