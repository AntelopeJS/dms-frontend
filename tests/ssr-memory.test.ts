import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { App } from "vue";

const RENDERS = 40;

setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc") as () => void;

interface LeakProbe {
  hooks: Set<() => unknown>;
  timers: NodeJS.Timeout[];
  rendered: number;
  released: number;
  track: (app: App) => void;
}

function leakProbe(): LeakProbe {
  const probe: LeakProbe = {
    hooks: new Set(),
    timers: [],
    rendered: 0,
    released: 0,
    track: (app) => {
      probe.rendered += 1;
      finalization.register(app, undefined);
    },
  };
  const finalization = new FinalizationRegistry(() => {
    probe.released += 1;
  });
  return probe;
}

/**
 * Collects until every rendered app is finalized, or gives up after a few
 * rounds: finalizers run as later tasks, never within the collection.
 */
async function retainedApps(probe: LeakProbe): Promise<number> {
  for (
    let round = 0;
    round < 20 && probe.rendered - probe.released > 1;
    round++
  ) {
    collectGarbage();
    await new Promise((settle) => setTimeout(settle, 10));
  }
  return probe.rendered - probe.released;
}

it("releases every server render once it is sent", async () => {
  const workspace = mkdtempSync(resolve(".ssr-memory-"));
  const previousBackend = process.env.DMS_API_BASE_URL;
  const previousEnvironment = process.env.NODE_ENV;
  // Production, like the hub: in development, Vue and vue-i18n register every
  // app with the devtools hook, which keeps them all on purpose.
  process.env.NODE_ENV = "production";
  const backend = createServer((request, response) => {
    const path = new URL(request.url!, "http://fixture").searchParams.get(
      "path",
    );
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ componentName: path?.slice(1) }));
  });
  let frontend: ReturnType<typeof createServer> | undefined;
  const probe = leakProbe();
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
      'export const localeMessages={en:{}};export const supportedLocales=["en"];export const loadLocaleMessages=async()=>({});',
    );
    writeFileSync(
      join(workspace, "ui-stub.ts"),
      `import {h} from 'vue'; export const useAppConfig=()=>({});export const useToast=()=>({add(){}});export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};`,
    );
    // Stands for Nuxt UI's `useRuntimeHook`: a process-wide registry a
    // component only leaves when its scope is disposed. The hook holds the
    // component instance, and through it the whole app. The page awaits the
    // way a compiled <script setup> does, and the plugin reads the route the
    // way the DMS layout's plugins do. The interval stands for a pooled
    // backend socket: opened during the render, it outlives it.
    writeFileSync(
      join(workspace, "frontend-modules.generated.ts"),
      `
import {defineComponent,getCurrentInstance,h,onScopeDispose,withAsyncContext} from 'vue';
import {useDmsRoute} from './frontend-module';
const probe=globalThis.__dmsLeakProbe;
function useProcessHook(){const instance=getCurrentInstance();const hook=()=>instance;probe.hooks.add(hook);onScopeDispose(()=>probe.hooks.delete(hook));}
const Widget=defineComponent({setup(){useProcessHook();return()=>h('span','widget')}});
export const frontendModules=[{options:{public:{}},module:{setup(sdk){
 sdk.registerPlugin((nuxtApp)=>{probe.track(nuxtApp.vueApp);useDmsRoute();onScopeDispose(()=>{})});
 sdk.registerPage('page',defineComponent({async setup(){useProcessHook();let pending,restore;[pending,restore]=withAsyncContext(()=>Promise.resolve());await pending;restore();useProcessHook();const route=useDmsRoute();probe.timers.push(setInterval(()=>{},60000));return()=>h('p',['Rendered '+route.path,h(Widget)])}}));
}}}];`,
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
    Reflect.set(globalThis, "__dmsLeakProbe", probe);
    const { handleRequestSafely } = await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    );
    frontend = createServer(handleRequestSafely);
    await new Promise<void>((settle) =>
      frontend!.listen(0, "127.0.0.1", settle),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    for (let render = 0; render < RENDERS; render += 1) {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/page?render=${render}`,
        { headers: { accept: "text/html" } },
      );
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Rendered \/page.*widget/);
    }
    assert.equal(probe.rendered, RENDERS);
    assert.equal(probe.hooks.size, 0);
    // Inertia keeps the head manager of the latest render in module state,
    // so that one render stays reachable until the next replaces it.
    assert.ok((await retainedApps(probe)) <= 1);
  } finally {
    probe.timers.forEach(clearInterval);
    Reflect.deleteProperty(globalThis, "__dmsLeakProbe");
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
    if (previousEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousEnvironment;
    rmSync(workspace, { recursive: true, force: true });
  }
});
