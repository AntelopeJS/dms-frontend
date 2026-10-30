import { createServer } from "node:http";
import { RequestBodyError, UpstreamError } from "./auth/backend.mjs";
import { UNEXPECTED_ERROR_BODY } from "./backend-response.mjs";
import { createServerModules, handleModuleRoute } from "./module-server.mjs";

/**
 * What the frontend server answers an API request whose handler failed.
 *
 * @param {unknown} error
 * @param {import("node:http").ServerResponse} response
 */
function writeFailure(error, response) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  const body =
    error instanceof UpstreamError || error instanceof RequestBodyError
      ? { message: error.message }
      : UNEXPECTED_ERROR_BODY;
  if (!response.headersSent)
    response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Starts an HTTP server on a free local port answering the modules' routes,
 * and `404` to anything else.
 *
 * Serves a frontend module's `dms.server.ts` routes the way the frontend server
 * does, for the module's own tests: same router, same event, same cookie jar
 * and the same defaults. Imported from
 * `@antelopejs/dms-frontend/templates/vue/server/module-testing.mjs`; the server reads
 * `DMS_API_BASE_URL` and `DMS_SESSION_SECRET` from the environment, as in
 * production.
 *
 * @param {readonly import("./module-server.mjs").ServerModuleDeclaration[]} declarations `{ id, priority?, setup }` per module, `setup` being
 *   the default export of its `dms.server.ts`
 * @param {Omit<import("./module-server.mjs").Deployment, "warn" | "authEstablishEndpoints"> & { authEstablishEndpoints?: readonly string[] }} [deployment] `{ publicOptions?, privateOptions?, authEstablishEndpoints?,
 *   publicEndpoints?, backendProxies? }`, options by module id, and the
 *   manifest's backend proxies (`{ module, path, auth? }`), which decide
 *   the backend redirects relayed as frontend paths. The private options are
 *   used as given, as the server uses the manifest's: no environment
 *   variable replaces a secret they hold
 * @returns `{ url, modules, warnings, close() }`
 */
export async function serveModuleRoutes(declarations, deployment = {}) {
  /** @type {string[]} */
  const warnings = [];
  const endpoints = deployment.authEstablishEndpoints ?? [];
  const modules = createServerModules(declarations, {
    ...deployment,
    authEstablishEndpoints: () => endpoints,
    warn: (message) => warnings.push(message),
  });
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url, "http://frontend.local");
    handleModuleRoute(request, response, pathname, modules)
      .then((answered) => {
        if (!answered) response.writeHead(404).end();
      })
      .catch((error) => writeFailure(error, response));
  });
  await new Promise((settle) => server.listen(0, "127.0.0.1", settle));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    modules,
    warnings,
    close: () =>
      new Promise((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  };
}
