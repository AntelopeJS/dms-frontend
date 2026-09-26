import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { it } from "node:test";
import { pathToFileURL } from "node:url";

it("renders setup errors as HTTP errors without corrupting simultaneous successful SSR", async () => {
  const workspace = mkdtempSync(resolve(".ssr-errors-"));
  const previousBackend = process.env.DMS_API_BASE_URL;
  const previousSecret = process.env.DMS_SESSION_SECRET;
  const unreadCountPath = "/settings/user/notifications/unread-count";
  const backend = createServer((request, response) => {
    const url = new URL(request.url!, "http://fixture");
    response.setHeader("content-type", "application/json");
    if (url.pathname === unreadCountPath) {
      response.end('{"unreadCount":7}');
      return;
    }
    const path = url.searchParams.get("path");
    if (path === null) {
      response.statusCode = 404;
      response.end('{"message":"Not found"}');
      return;
    }
    if (path === "/suspended") {
      response.writeHead(403, { "content-type": "text/plain" });
      response.end("fixture.errors.access_blocked");
      return;
    }
    if (path === "/broken") response.statusCode = 503;
    response.end(JSON.stringify({ componentName: path.slice(1) }));
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
      'export const localeMessages={en:{},fr:{}};export const supportedLocales=["en","fr"];export const loadLocaleMessages=async()=>({});',
    );
    writeFileSync(
      join(workspace, "ui-stub.ts"),
      `import {h} from 'vue'; export const useAppConfig=()=>({});export default {install(){},setup(_,{slots}){return()=>h('div',null,slots.default?.())}};`,
    );
    writeFileSync(
      join(workspace, "frontend-modules.generated.ts"),
      `
import {defineComponent,h} from 'vue';
import {createError,defineDmsPageMeta,useUserSession,useI18n,useDmsState} from './frontend-module';
let exactPreloads=0;
let catchAllPreloads=0;
let initialMiddlewarePath='unset';
export const frontendModules=[{options:{public:{}},module:{setup(sdk){
 sdk.registerMiddleware('capture-initial-route',to=>{initialMiddlewarePath=to.fullPath},{global:true});
 sdk.registerMiddleware('async-runtime',async to=>{if(!to.path.startsWith('/async-runtime'))return;await Promise.resolve();useDmsState('async-runtime',()=>undefined).value=to.path},{global:true});
 sdk.registerMiddleware('onboarding-redirect',to=>to.path.startsWith('/requires-onboarding-')?'/onboarding?source='+to.path.slice(-1):undefined,{global:true});
 sdk.registerPlugin(()=>{const {user}=useUserSession();useDmsState('plugin-user',()=>user.value?._id??'anonymous')});
 sdk.registerPage('session',defineComponent({setup(){const {user}=useUserSession();const {locale}=useI18n();const pluginUser=useDmsState('plugin-user');return()=>h('p',(user.value?._id??'anonymous')+':'+locale.value+':'+pluginUser.value)}}));
 sdk.registerPage('async-runtime-a',defineComponent({async setup(){defineDmsPageMeta({auth:true});await Promise.resolve();const value=useDmsState('async-runtime');return()=>h('p','Async runtime A:'+value.value)}}));
 sdk.registerPage('async-runtime-b',defineComponent({async setup(){defineDmsPageMeta({auth:true});await Promise.resolve();const value=useDmsState('async-runtime');return()=>h('p','Async runtime B:'+value.value)}}));
 sdk.registerPage('initial-route',defineComponent({setup(){defineDmsPageMeta({auth:true});return()=>h('p','Initial route:'+initialMiddlewarePath)}}));
 const RequiresOnboarding=defineComponent({setup(){defineDmsPageMeta({auth:true});return()=>h('p','Redirecting to onboarding')}});
 sdk.registerPage('requires-onboarding-a',RequiresOnboarding);
 sdk.registerPage('requires-onboarding-b',RequiresOnboarding);
 sdk.registerPage('onboarding',defineComponent({setup(){return()=>h('p','Onboarding')}}));
 sdk.registerPage('throws',defineComponent({setup(){throw createError({statusCode:400,message:'Missing required token parameter'})},render(){throw new Error('secondary render failure')}}));
 sdk.registerPage('async-throws',defineComponent({async setup(){await Promise.resolve();throw new Error('private database hostname')}}));
 sdk.registerPage('healthy',defineComponent({async setup(){await new Promise(r=>setTimeout(r,5));return()=>h('p','Healthy request')}}));
 sdk.registerPage('exact',defineComponent({setup(){return()=>h('p','Exact registered page:'+(exactPreloads>0)+':catch-all:'+catchAllPreloads)}}),async()=>{exactPreloads++});
 sdk.registerDynamicPage('[...slug]',defineComponent({setup(){return()=>h('p','Registered catch-all page:'+(catchAllPreloads>0))}}),async()=>{catchAllPreloads++});
 sdk.registerAccessRedirect('fixture.errors.access_blocked','/blocked-screen');
 sdk.registerErrorPage(defineComponent({props:['error'],setup(props){return()=>h('main',{id:'error'},props.error.statusCode+': '+props.error.message)}}));
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
    await new Promise<void>((resolve) =>
      backend.listen(0, "127.0.0.1", resolve),
    );
    const backendAddress = backend.address();
    assert.ok(backendAddress && typeof backendAddress === "object");
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${backendAddress.port}`;
    const { handleRequestSafely } = await import(
      pathToFileURL(join(workspace, "server.mjs")).href
    );
    frontend = createServer(handleRequestSafely);
    await new Promise<void>((resolve) =>
      frontend!.listen(0, "127.0.0.1", resolve),
    );
    const address = frontend.address();
    assert.ok(address && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}`;
    const [failed, healthy] = await Promise.all([
      fetch(`${base}/throws`, { headers: { accept: "text/html" } }),
      fetch(`${base}/healthy`, { headers: { accept: "text/html" } }),
    ]);
    assert.equal(failed.status, 400);
    const failedHtml = await failed.text();
    assert.match(failedHtml, /400: Missing required token parameter/);
    assert.doesNotMatch(failedHtml, /WRONG PAGE/);
    assert.equal(healthy.status, 200);
    const healthyHtml = await healthy.text();
    assert.match(healthyHtml, /Healthy request/);
    assert.doesNotMatch(healthyHtml, /Missing required token parameter/);
    const initialRoute = await fetch(
      `${base}/initial-route?tab=public#details`,
      { headers: { accept: "text/html" } },
    );
    assert.equal(initialRoute.status, 200);
    assert.match(
      await initialRoute.text(),
      /Initial route:\/initial-route\?tab=public/,
    );
    const [redirectA, redirectB, isolatedHealthy] = await Promise.all([
      fetch(`${base}/requires-onboarding-a`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
      fetch(`${base}/requires-onboarding-b`, {
        headers: { accept: "text/html" },
        redirect: "manual",
      }),
      fetch(`${base}/healthy`, { headers: { accept: "text/html" } }),
    ]);
    assert.equal(redirectA.status, 302);
    assert.equal(redirectA.headers.get("location"), "/onboarding?source=a");
    assert.equal(redirectB.status, 302);
    assert.equal(redirectB.headers.get("location"), "/onboarding?source=b");
    assert.equal(isolatedHealthy.status, 200);
    assert.match(await isolatedHealthy.text(), /Healthy request/);
    const asyncRuntimeResponses = await Promise.all([
      fetch(`${base}/async-runtime-a`, { headers: { accept: "text/html" } }),
      fetch(`${base}/async-runtime-b`, { headers: { accept: "text/html" } }),
    ]);
    const asyncRuntimeHtml = await Promise.all(
      asyncRuntimeResponses.map((response) => response.text()),
    );
    assert.match(asyncRuntimeHtml[0], /Async runtime A:\/async-runtime-a/);
    assert.doesNotMatch(asyncRuntimeHtml[0], /Async runtime B/);
    assert.match(asyncRuntimeHtml[1], /Async runtime B:\/async-runtime-b/);
    assert.doesNotMatch(asyncRuntimeHtml[1], /Async runtime A/);
    const unexpected = await fetch(`${base}/async-throws`, {
      headers: { accept: "text/html" },
    });
    assert.equal(unexpected.status, 500);
    const unexpectedHtml = await unexpected.text();
    assert.match(unexpectedHtml, /500: An unexpected error occurred/);
    assert.doesNotMatch(unexpectedHtml, /private database hostname/);
    const exact = await fetch(`${base}/exact`, {
      headers: { accept: "text/html" },
    });
    assert.equal(exact.status, 200);
    const exactHtml = await exact.text();
    assert.match(exactHtml, /Exact registered page:true:catch-all:0/);
    assert.doesNotMatch(exactHtml, /Registered catch-all page/);
    const catchAll = await fetch(`${base}/unregistered`, {
      headers: { accept: "text/html" },
    });
    assert.equal(catchAll.status, 200);
    assert.match(await catchAll.text(), /Registered catch-all page:true/);
    const [onboardingDocument, nestedDocument, unreadCount] = await Promise.all(
      [
        fetch(`${base}/onboarding`),
        fetch(`${base}/modules/parity/nested`),
        fetch(`${base}${unreadCountPath}`),
      ],
    );
    const productionHtml = await Promise.all(
      [onboardingDocument, nestedDocument].map(async (response) => {
        assert.equal(response.status, 200);
        assert.match(response.headers.get("content-type") ?? "", /text\/html/);
        return response.text();
      }),
    );
    assert.match(productionHtml[0], /Onboarding/);
    assert.match(productionHtml[1], /Registered catch-all page:true/);
    assert.equal(unreadCount.status, 200);
    assert.deepEqual(await unreadCount.json(), { unreadCount: 7 });
    process.env.DMS_SESSION_SECRET =
      "disposable-ssr-session-secret-at-least-32";
    const { writeSession } = await import(
      pathToFileURL(join(workspace, "server/auth/session.mjs")).href
    );
    const sessionCookie = (id: string, language: string) => {
      let cookie = "";
      writeSession(
        {
          getHeader: () => undefined,
          setHeader: (_name: string, value: string) => {
            cookie = value.split(";")[0];
          },
        },
        {
          user: { _id: id, language },
          accountId: `account-${id}`,
          activeTenantId: `tenant-${id}`,
          accessToken: "private-access-token",
          refreshToken: "private-refresh-token",
        },
      );
      return cookie;
    };
    const sessions = await Promise.all([
      fetch(`${base}/session`, {
        headers: { accept: "text/html", cookie: sessionCookie("alice", "fr") },
      }),
      fetch(`${base}/session`, {
        headers: { accept: "text/html", cookie: sessionCookie("bob", "en") },
      }),
      fetch(`${base}/session`, { headers: { accept: "text/html" } }),
    ]);
    for (const [index, [expected, locale]] of [
      ["alice:fr:alice", "fr"],
      ["bob:en:bob", "en"],
      ["anonymous:en:anonymous", "en"],
    ].entries()) {
      assert.equal(sessions[index].status, 200);
      const html = await sessions[index].text();
      assert.ok(
        html.includes(expected),
        `Session and locale must exist before plugin setup: ${expected}`,
      );
      assert.match(html, new RegExp(`lang="${locale}"`));
      assert.doesNotMatch(html, /private-access-token|private-refresh-token/);
    }
    const inertiaSession = await fetch(`${base}/session`, {
      headers: {
        cookie: sessionCookie("alice", "fr"),
        "x-inertia": "true",
      },
    });
    assert.deepEqual((await inertiaSession.json()).props, {
      path: "/session",
      page: { componentName: "session" },
      user: { _id: "alice", language: "fr" },
      session: {
        accountId: "account-alice",
        activeTenantId: "tenant-alice",
      },
      errors: {},
    });
    const failedSession = await fetch(`${base}/broken`, {
      headers: {
        cookie: sessionCookie("bob", "en"),
        "x-inertia": "true",
      },
    });
    assert.equal(failedSession.status, 503);
    const failedSessionBody = await failedSession.text();
    assert.match(failedSessionBody, /account-bob|tenant-bob/);
    assert.match(failedSessionBody, /An unexpected error occurred/);
    assert.doesNotMatch(failedSessionBody, /DMS backend request failed/);
    assert.doesNotMatch(
      failedSessionBody,
      /private-access-token|private-refresh-token/,
    );
    for (const headers of [{ accept: "text/html" }, { "x-inertia": "true" }]) {
      const suspended = await fetch(`${base}/suspended`, {
        headers: { ...headers, cookie: sessionCookie("bob", "en") },
        redirect: "manual",
      });
      assert.equal(suspended.status, 302);
      assert.equal(suspended.headers.get("location"), "/blocked-screen");
    }
  } finally {
    frontend?.close();
    backend.close();
    if (previousBackend === undefined) delete process.env.DMS_API_BASE_URL;
    else process.env.DMS_API_BASE_URL = previousBackend;
    if (previousSecret === undefined) delete process.env.DMS_SESSION_SECRET;
    else process.env.DMS_SESSION_SECRET = previousSecret;
    rmSync(workspace, { recursive: true, force: true });
  }
});
