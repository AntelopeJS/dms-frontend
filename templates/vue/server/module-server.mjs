// Loads what the frontend modules declare in their `dms.server.ts` and hands
// a request to the module route it reaches. In development the declarations
// come from Vite (`ssrLoadModule`), so an edited entry or handler answers on
// the next request; in production from the bundle `ajs dms build` makes
// (`dist/server-modules`). A workspace built before the feature has none.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowedEstablishEndpoints } from "./auth/establish-endpoints.mjs";
import { serverAuth } from "./auth-hooks.mjs";
import { answerModuleRoute } from "./module-event.mjs";
import {
  matchModuleRoute,
  mayHaveModuleRoute,
  moduleRouteMethods,
  resolveServerDeclarations,
} from "./module-routes.mjs";
import {
  allowedPublicEndpoints,
  environmentBackendProxies,
  readDeclaredBackendProxies,
} from "./public-endpoints.mjs";

const WORKSPACE_ROOT = new URL("../", import.meta.url);
const SOURCE_LOADER = "/server-modules.generated.ts";
const BUILT_LOADER = new URL(
  "dist/server-modules/server-modules.generated.js",
  WORKSPACE_ROOT,
);
const REGISTRY_FILE = new URL(
  "generated-frontend-modules.json",
  WORKSPACE_ROOT,
);
const SERVER_OPTIONS_FILE = new URL(
  "generated-server-options.json",
  WORKSPACE_ROOT,
);

let builtDeclarations;
let lastDeclarations = [];
let lastLoadError;
const resolved = new WeakMap();

function readJsonFile(url, fallback) {
  try {
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return fallback;
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** The object holding `path`'s last key, when every key up to it is own. */
function holderOf(target, path) {
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (UNSAFE_KEYS.has(key) || !Object.hasOwn(node, key)) return undefined;
    node = node[key];
    if (typeof node !== "object" || node === null) return undefined;
  }
  return UNSAFE_KEYS.has(path.at(-1)) ? undefined : node;
}

/** Sets `value` at `path` when the object holding it exists but lacks it. */
function fillPath(target, path, value) {
  const holder = holderOf(target, path);
  const key = path.at(-1);
  if (holder && (holder[key] === undefined || holder[key] === ""))
    holder[key] = value;
}

/** Sets `value` at `path` only where the build left an empty string. */
function fillEmptied(target, path, value) {
  const holder = holderOf(target, path);
  const key = path.at(-1);
  if (holder && Object.hasOwn(holder, key) && holder[key] === "")
    holder[key] = value;
}

/**
 * Each module's private options, the secrets the manifest publishes first:
 * the environment variable of a secret (`DMS_HTML_RENDER_SECRET`,
 * `DMS_OAUTH_RELAY_SECRET`) only fills in a section that carries none.
 *
 * @param modules The private options by module id, as the manifest published
 *   them
 * @param environment The variables by the path of the secret they stand for
 * @param env The process environment
 */
export function privateOptionsWithFallbacks(modules, environment, env) {
  for (const options of Object.values(modules))
    for (const [name, path] of Object.entries(environment))
      if (env[name]) fillPath(options, path, env[name]);
  return modules;
}

/** Each string leaf of `value`, array items included, with its path. */
function* stringLeaves(value, path = []) {
  if (typeof value === "string") yield [path, value];
  else if (typeof value === "object" && value !== null)
    for (const [key, child] of Object.entries(value))
      yield* stringLeaves(child, [...path, key]);
}

/**
 * Fills the private values a build left empty from `DMS_PRIVATE_OPTIONS`, a
 * JSON object of private options by module id
 * (`{"acme__shop-frontend-vue":{"apiKey":"…"}}`): any module's secrets, where
 * `DMS_HTML_RENDER_SECRET` and `DMS_OAUTH_RELAY_SECRET` name two of them. Only
 * a value the build emptied is filled, array items included: a value the
 * manifest carries wins, and no option or section is added or replaced.
 *
 * @param modules The private options by module id
 * @param json The variable's value; nothing is filled when unset
 * @param warn Reports a value that is not a JSON object, never its content
 */
export function privateOptionsFromJson(modules, json, warn) {
  if (!json) return modules;
  let given;
  try {
    given = JSON.parse(json);
  } catch {
    given = undefined;
  }
  if (typeof given !== "object" || given === null || Array.isArray(given)) {
    warn("DMS_PRIVATE_OPTIONS is not a JSON object of options by module id");
    return modules;
  }
  for (const [id, options] of Object.entries(given)) {
    if (UNSAFE_KEYS.has(id) || !Object.hasOwn(modules, id)) continue;
    for (const [path, value] of stringLeaves(options))
      if (path.length > 0) fillEmptied(modules[id], path, value);
  }
  return modules;
}

function readPrivateOptions(env = process.env) {
  const { modules = {}, environment = {} } = readJsonFile(
    SERVER_OPTIONS_FILE,
    {},
  );
  return privateOptionsFromJson(
    privateOptionsWithFallbacks(modules, environment, env),
    env.DMS_PRIVATE_OPTIONS,
    (message) => console.warn(message),
  );
}

function readPublicOptions() {
  const registry = readJsonFile(REGISTRY_FILE, { modules: [] });
  return Object.fromEntries(
    registry.modules.map((module) => [module.id, module.options]),
  );
}

async function loadDeclarations(devServer) {
  if (devServer)
    return (await devServer.ssrLoadModule(SOURCE_LOADER)).serverModules;
  if (!existsSync(fileURLToPath(BUILT_LOADER))) return [];
  builtDeclarations ??= import(BUILT_LOADER.href).then(
    (loaded) => loaded.serverModules,
  );
  return builtDeclarations;
}

/**
 * The declarations to serve. A module entry that fails to load in development
 * (a syntax error being typed) is reported once, and the last routes that
 * loaded keep answering meanwhile.
 */
async function currentDeclarations(devServer) {
  try {
    lastDeclarations = (await loadDeclarations(devServer)) ?? [];
    lastLoadError = undefined;
  } catch (error) {
    if (!devServer) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastLoadError)
      console.error("DMS server modules failed to load", error);
    lastLoadError = message;
  }
  return lastDeclarations;
}

/**
 * A set of server modules, resolved for a deployment.
 *
 * @param declarations `{ id, priority, setup }` per module with a dms.server.ts
 * @param deployment `{ publicOptions, privateOptions, authEstablishEndpoints,
 *   publicEndpoints, backendProxies, warn }`: each module's options by id,
 *   the session-opening endpoints as a function (the environment can change
 *   them), the public endpoints, the backend proxies the manifest declares
 *   (`{ module, path, auth? }`), and where declaration problems are reported
 * @returns `{ routes, auth, context(id), serverAuth }`: `context` is what a
 *   handler of that module reads besides its request, `serverAuth` the
 *   session logic the module owning sign-in provides (see `auth-hooks.mjs`)
 */
export function createServerModules(declarations, deployment) {
  const resolution = resolveServerDeclarations(
    declarations,
    deployment.warn,
    deployment.publicEndpoints ?? [],
    deployment.backendProxies ?? [],
  );
  const context = (id) => ({
    module: {
      id,
      options: deployment.publicOptions?.[id],
      privateOptions: deployment.privateOptions?.[id],
    },
    app: {
      authEstablishEndpoints: deployment.authEstablishEndpoints?.() ?? [],
    },
    // The module whose sealed cookies are the `dms_*` ones.
    authOwner: resolution.auth?.id,
  });
  return {
    ...resolution,
    context,
    serverAuth: serverAuth(resolution.auth, context),
  };
}

/** Resolved once per set of declarations: in development, once per edit. */
function serverModules(declarations) {
  let modules = resolved.get(declarations);
  if (!modules) {
    modules = createServerModules(declarations, {
      publicOptions: readPublicOptions(),
      privateOptions: readPrivateOptions(),
      authEstablishEndpoints: () => allowedEstablishEndpoints(),
      publicEndpoints: allowedPublicEndpoints(),
      backendProxies: [
        ...readDeclaredBackendProxies(),
        ...environmentBackendProxies(),
      ],
      warn: (message) => console.warn(message),
    });
    resolved.set(declarations, modules);
  }
  return modules;
}

/**
 * The server modules of this deployment, resolved.
 *
 * @param devServer Vite in development, `undefined` in production
 */
export async function loadServerModules(devServer) {
  return serverModules(await currentDeclarations(devServer));
}

/**
 * Answers `request` with the module route it reaches, if any. A path a
 * module route serves is the module's for every method: another method is
 * answered `405`.
 *
 * @param request The Node request
 * @param response The Node response
 * @param pathname The request's normalized path
 * @param modules What `loadServerModules` or `createServerModules` returned
 * @returns Whether a module route answered
 */
export async function handleModuleRoute(request, response, pathname, modules) {
  if (!mayHaveModuleRoute(pathname)) return false;
  const reached = matchModuleRoute(modules.routes, request.method, pathname);
  if (!reached) {
    const allowed = moduleRouteMethods(modules.routes, pathname);
    if (!allowed.length) return false;
    response.writeHead(405, {
      allow: allowed.join(", "),
      "content-type": "application/json",
    });
    response.end(JSON.stringify({ message: "Method not allowed" }));
    return true;
  }
  await answerModuleRoute({
    request,
    response,
    route: reached.route,
    params: reached.params,
    view: modules.serverAuth.view,
    ...modules.context(reached.route.id),
  });
  return true;
}
