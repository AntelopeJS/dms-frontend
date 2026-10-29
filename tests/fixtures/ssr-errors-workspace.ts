import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Materializes the renderer template into `workspace` with the stubs and pages the SSR error scenarios render. */
export function writeSsrErrorsWorkspace(
  workspace: string,
  unreadCountPath: string,
): void {
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
    `
import {defineComponent,h} from 'vue';
import {createDmsError,defineDmsPageMeta,navigateDms,useDmsFetch,useDmsRoute,useDmsRouter,useDmsUserSession,useI18n,useDmsState} from './frontend-module';
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let exactPreloads=0;
let catchAllPreloads=0;
let initialMiddlewarePath='unset';
export const frontendModules=[{options:{public:{}},module:{setup(sdk){
 sdk.registerMiddleware('capture-initial-route',to=>{initialMiddlewarePath=to.fullPath},{global:true});
 sdk.registerMiddleware('async-runtime',async to=>{if(!to.path.startsWith('/async-runtime'))return;await Promise.resolve();useDmsState('async-runtime',()=>undefined).value=to.path},{global:true});
 sdk.registerMiddleware('slow-guard',async to=>{if(!to.path.startsWith('/slow-guard-'))return;await sleep(20);if(to.path!=='/slow-guard-page-redirect')return '/onboarding?source=guard'},{global:true});
 sdk.registerPage('slow-guard-redirect',defineComponent({setup(){defineDmsPageMeta({auth:true});return()=>h('p','Guarded page')}}));
 sdk.registerPage('slow-guard-page-redirect',defineComponent({async setup(){defineDmsPageMeta({auth:true});await navigateDms('/onboarding?source=page');return()=>h('p','Leaving page')}}));
 sdk.registerPage('slow-guard-both',defineComponent({async setup(){defineDmsPageMeta({auth:true});await navigateDms('/onboarding?source=page');return()=>h('p','Leaving page')}}));
 sdk.registerMiddleware('failing-guard',async to=>{if(!to.path.startsWith('/guard-'))return;await Promise.resolve();if(to.path==='/guard-not-found')throw createDmsError({statusCode:404,statusMessage:'Module not found'});if(to.path==='/guard-broken')throw new Error('private middleware detail');return '/onboarding?source=guard'},{global:true});
 const Guarded=defineComponent({async setup(){defineDmsPageMeta({auth:true});await new Promise(r=>setTimeout(r,20));return()=>h('p','Guarded content')}});
 sdk.registerPage('guard-not-found',Guarded);
 sdk.registerPage('guard-broken',Guarded);
 sdk.registerPage('guard-redirect',Guarded);
 sdk.registerMiddleware('onboarding-redirect',to=>to.path.startsWith('/requires-onboarding-')?'/onboarding?source='+to.path.slice(-1):undefined,{global:true});
 sdk.registerPlugin(()=>{const {user}=useDmsUserSession();useDmsState('plugin-user',()=>user.value?._id??'anonymous')});
 sdk.registerPage('session',defineComponent({setup(){const {user}=useDmsUserSession();const {locale}=useI18n();const pluginUser=useDmsState('plugin-user');return()=>h('p',(user.value?._id??'anonymous')+':'+locale.value+':'+pluginUser.value)}}));
 sdk.registerPage('async-runtime-a',defineComponent({async setup(){defineDmsPageMeta({auth:true});await Promise.resolve();const value=useDmsState('async-runtime');return()=>h('p','Async runtime A:'+value.value)}}));
 sdk.registerPage('async-runtime-b',defineComponent({async setup(){defineDmsPageMeta({auth:true});await Promise.resolve();const value=useDmsState('async-runtime');return()=>h('p','Async runtime B:'+value.value)}}));
 sdk.registerPage('initial-route',defineComponent({setup(){defineDmsPageMeta({auth:true});return()=>h('p','Initial route:'+initialMiddlewarePath)}}));
 const RequiresOnboarding=defineComponent({setup(){defineDmsPageMeta({auth:true});return()=>h('p','Redirecting to onboarding')}});
 sdk.registerPage('requires-onboarding-a',RequiresOnboarding);
 sdk.registerPage('requires-onboarding-b',RequiresOnboarding);
 sdk.registerPage('onboarding',defineComponent({setup(){return()=>h('p','Onboarding')}}));
 sdk.registerPage('fill-query',defineComponent({async setup(){const route=useDmsRoute();const router=useDmsRouter();const {data}=await useDmsFetch('/fixture/counted');if(!route.query.workspace)await router.replace(route.query.loop?'/fill-query?loop='+(Number(route.query.loop)+1):'/fill-query?workspace=default');return()=>h('p','Fill:'+route.query.workspace+':'+data.value?.count)}}));
 sdk.registerPage('throws',defineComponent({setup(){throw createDmsError({statusCode:400,message:'Missing required token parameter'})},render(){throw new Error('secondary render failure')}}));
 sdk.registerPage('fetch-not-found',defineComponent({async setup(){await Promise.resolve();throw Object.assign(new Error('[GET] "http://10.0.0.5:5010/api/secret": 404 Not Found'),{name:'FetchError',statusCode:404,statusMessage:'Not Found'})}}));
 sdk.registerPage('async-throws',defineComponent({async setup(){await Promise.resolve();throw new Error('private database hostname')}}));
 sdk.registerPage('healthy',defineComponent({async setup(){await new Promise(r=>setTimeout(r,5));return()=>h('p','Healthy request')}}));
 sdk.registerPage('exact',defineComponent({setup(){return()=>h('p','Exact registered page:'+(exactPreloads>0)+':catch-all:'+catchAllPreloads)}}),async()=>{exactPreloads++});
 sdk.registerDynamicPage('[...slug]',defineComponent({setup(){return()=>h('p','Registered catch-all page:'+(catchAllPreloads>0))}}),async()=>{catchAllPreloads++});
 sdk.registerAccessRedirect('fixture.errors.access_blocked','/blocked-screen');
 sdk.registerErrorPage(defineComponent({props:['error'],setup(props){return()=>h('main',{id:'error'},props.error.statusCode+': '+(props.error.message??'no message')+' / '+(props.error.statusMessage??'no status message'))}}));
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
  mkdirSync(join(workspace, "dist/server-modules"), { recursive: true });
  writeFileSync(
    join(workspace, "dist/server-modules/server-modules.generated.js"),
    `export const serverModules = [{ id: "fixture-auth", setup(server) {
server.registerAuth({ publicSession: (session) => ({ user: session.user, session: { accountId: session.accountId, activeTenantId: session.activeTenantId } }) });
server.registerBackendProxy(${JSON.stringify(unreadCountPath)});
} }];\n`,
  );
}
