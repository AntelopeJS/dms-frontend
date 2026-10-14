// Loads what the frontend modules declare in their `dms.server.ts` and hands
// a request to the module route it reaches. In development the declarations
// come from Vite (`ssrLoadModule`), so an edited entry or handler answers on
// the next request; in production from the bundle `ajs dms build` makes
// (`dist/server-modules`). A workspace built before the feature has none.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allowedEstablishEndpoints } from "./auth/routes.mjs";
import { serverAuth } from "./auth-hooks.mjs";
import { answerModuleRoute } from "./module-event.mjs";
import {
  matchModuleRoute,
  mayHaveModuleRoute,
  resolveServerDeclarations,
} from "./module-routes.mjs";
import { allowedPublicEndpoints } from "./public-endpoints.mjs";

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

function setPath(target, path, value) {
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (typeof node[key] !== "object" || node[key] === null) return;
    node = node[key];
  }
  if (path.at(-1) in node) node[path.at(-1)] = value;
}

/**
 * Each module's private options, as the manifest published them. A secret the
 * environment sets (`DMS_HTML_RENDER_SECRET`, `DMS_OAUTH_RELAY_SECRET`)
 * replaces the published value where a module carries it, as it does for the
 * built-in routes.
 */
function readPrivateOptions(env = process.env) {
  const { modules = {}, environment = {} } = readJsonFile(
    SERVER_OPTIONS_FILE,
    {},
  );
  for (const options of Object.values(modules))
    for (const [name, path] of Object.entries(environment))
      if (env[name]) setPath(options, path, env[name]);
  return modules;
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
 *   publicEndpoints, warn }`: each module's options by id, the session-opening
 *   endpoints as a function (the environment can change them), the public
 *   endpoints, and where declaration problems are reported
 * @returns `{ routes, auth, context(id), serverAuth }`: `context` is what a
 *   handler of that module reads besides its request, `serverAuth` the
 *   session logic the module owning sign-in provides (see `auth-hooks.mjs`)
 */
export function createServerModules(declarations, deployment) {
  const resolution = resolveServerDeclarations(
    declarations,
    deployment.warn,
    deployment.publicEndpoints ?? [],
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
 * Answers `request` with the module route it reaches, if any.
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
  if (!reached) return false;
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
