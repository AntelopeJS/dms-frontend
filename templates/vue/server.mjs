import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, maxHeaderSize } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestBodyError, UpstreamError } from "./server/auth/backend.mjs";
import {
  backendJson,
  serverComponentFetch,
} from "./server/backend-request.mjs";
import { readSession } from "./server/auth/session.mjs";
import {
  BackendResponseError,
  redirectAccessRefusal,
  UNEXPECTED_ERROR_BODY,
} from "./server/backend-response.mjs";
import { handleClientError } from "./server/client-error.mjs";
import {
  reportListenError,
  reportReady,
  reportStartError,
} from "./server/cli-report.mjs";
import { publicBuildFile } from "./server/built-files.mjs";
import { serveStaticFile } from "./server/static-files.mjs";
import {
  localeCatalogPreloadTag,
  productionHtmlTemplate,
} from "./server/client-manifest.mjs";
import { writeContent } from "./server/content.mjs";
import {
  captureViteErrors,
  runViteMiddlewares,
  writeViteError,
} from "./server/vite-errors.mjs";
import { documentStyleTags } from "./server/dev-styles.mjs";
import { watchEmailBundle } from "./server/email.mjs";
import { withFaviconPlaceholder } from "./server/favicon.mjs";
import { DEV_FS_DENY, denyPrivateFiles } from "./server/dev-private-files.mjs";
import {
  ownerLabel,
  reachesBackend,
  requestOwner,
} from "./server/request-routing.mjs";
import { routingReport } from "./server/backend-proxies.mjs";
import { routeRuleFor, ruleHeaders } from "./server/route-rules.mjs";
import {
  handleModuleRoute,
  loadServerModules,
} from "./server/module-server.mjs";
import {
  redirectSignedOutPrivatePage,
  redirectToHomepage,
} from "./server/page-redirects.mjs";
import { publicOptionsScript } from "./server/public-options.mjs";
import { renderInPlace } from "./server/in-place-render.mjs";
import {
  loadPageProps,
  pageRoute,
  propsForQuery,
} from "./server/page-props.mjs";
import { htmlTag } from "./server/html-tag.mjs";
import { listenHost } from "./server/listen-host.mjs";
import * as icons from "./server/icons.mjs";
import * as requestFailure from "./server/request-failure.mjs";
import { proxy } from "./server/proxy-request.mjs";
import { refuseForeignTarget } from "./server/request-target.mjs";
import { SERVER_OPTIONS } from "./server/proxy-transfers.mjs";
import {
  createInertiaPage,
  htmlHeaders,
  inertiaAppHtml,
  inertiaHeaders,
  isFrontendVisit,
  redirectFrontendVisit,
  handleAssetVersionMismatch,
} from "./server/inertia.mjs";
export * from "./server/inertia.mjs";

/** @typedef {import("node:http").IncomingMessage} IncomingMessage */
/** @typedef {import("node:http").ServerResponse} ServerResponse */
/** @typedef {import("vite").ViteDevServer} ViteDevServer */
/** @typedef {import("./server/inertia.mjs").InertiaPage} InertiaPage */
/** @typedef {import("./server/in-place-render.mjs").ServerReads} ServerReads */

const INERTIA_HEADER = "x-inertia";
const JSON_TYPE = "application/json";
const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url));
const LOCAL_ROUTES = [[icons.isIconRequest, icons.handleIcons]];
const CLIENT_ROOT = join(PROJECT_ROOT, "dist/client");
const SOURCE_TEMPLATE_PATH = join(PROJECT_ROOT, "index.html");
/**
 * A URL, not a path: on Windows, `import()` reads `C:\...` as a URL whose
 * scheme is `c:` and refuses it.
 */
const BUILT_SSR_RENDERER_URL = new URL(
  "dist/ssr/ssr-renderer.js",
  import.meta.url,
);

/**
 * The SSR bundle keeps vue-i18n external, so Node loads its esm-bundler build,
 * which reads compile-time flags only a bundler replaces. Vite inlines them in
 * the client bundle; without the same value here, installing vue-i18n under
 * NODE_ENV=production throws a ReferenceError on the first render.
 */
function defineVueCompileFlags() {
  globalThis.__VUE_PROD_DEVTOOLS__ ??= false;
}

defineVueCompileFlags();
/** @type {Promise<typeof import("./ssr-renderer.ts")> | undefined} */
let productionSsrRenderer;
/** @type {ViteDevServer | undefined} */
let vite;
/** @type {Promise<ViteDevServer> | undefined} */
let vitePromise;
/** @type {import("node:http").Server | undefined} */
let frontendHttpServer;

/** @returns {Promise<ViteDevServer | undefined>} */
async function developmentServer() {
  if (process.env.DMS_DEV !== "true") return undefined;
  if (vite) return vite;
  vitePromise ??= import("vite")
    .then(({ createServer: createViteServer }) => {
      /** @type {import("vite").ServerOptions} */
      const serverOptions = {
        middlewareMode: true,
        fs: { deny: DEV_FS_DENY },
      };
      if (frontendHttpServer) serverOptions.ws = { server: frontendHttpServer };
      return createViteServer({
        server: serverOptions,
        appType: "custom",
        plugins: [denyPrivateFiles(), captureViteErrors()],
      });
    })
    .then((server) => {
      vite = server;
      return server;
    })
    .catch((error) => {
      vitePromise = undefined;
      throw error;
    });
  return vitePromise;
}

/** The session logic of the module that owns sign-in. */
async function currentAuth() {
  return (await loadServerModules(await developmentServer())).serverAuth;
}

/**
 * @param {IncomingMessage} request
 * @returns {import("./server/page-props.mjs").PageBackend}
 */
function pageBackend(request) {
  return {
    fetchJson: (path) => backendJson(path, request),
    isFrontendPage: async (pathname) =>
      (await ssrRenderer(await developmentServer())).isDmsFrontendPage(
        pathname,
      ),
  };
}

/**
 * @param {IncomingMessage} request
 * @param {import("./server/page-props.mjs").PageAuth} auth
 */
function pageProps(request, auth) {
  return loadPageProps(request, pageBackend(request), auth);
}

/**
 * Send the built file `pathname` names, or `false` when the build has none
 * there. `publicBuildFile` decides which file that is; `serveStaticFile` how
 * it goes out.
 *
 * @param {string} pathname
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @returns {boolean}
 */
function serveAsset(pathname, request, response) {
  const file = publicBuildFile(CLIENT_ROOT, pathname);
  if (!file) return false;
  serveStaticFile(file, request, response, {
    immutable: pathname.startsWith("/assets/"),
  });
  return true;
}

/**
 * @param {ViteDevServer | undefined} devServer
 * @returns {Promise<typeof import("./ssr-renderer.ts")>}
 */
async function ssrRenderer(devServer) {
  /** @type {typeof import("./ssr-renderer.ts")} */
  const renderer = devServer
    ? await devServer.ssrLoadModule("/ssr-renderer.ts")
    : await (productionSsrRenderer ??= import(BUILT_SSR_RENDERER_URL.href));
  await icons.provideIconCollections(renderer);
  return renderer;
}

/**
 * @param {InertiaPage} page
 * @returns {import("./ssr-renderer.ts").DmsSsrResult}
 */
function clientRenderedShell(page) {
  return {
    body: inertiaAppHtml(page),
    head: { headTags: "", htmlAttrs: "", bodyAttrs: "" },
    overlays: "",
    modules: [],
  };
}

/**
 * @param {InertiaPage} page
 * @param {ServerReads} serverFetch
 * @param {string | undefined} requestCookies
 * @param {ViteDevServer | undefined} devServer
 */
async function serverRendered(page, serverFetch, requestCookies, devServer) {
  try {
    const renderer = await ssrRenderer(devServer);
    return await renderer.renderDmsPage(page, serverFetch, requestCookies);
  } catch (error) {
    console.error(
      "DMS SSR render failed; falling back to client rendering",
      error,
    );
    return { ...clientRenderedShell(page), error: { statusCode: 500 } };
  }
}

/**
 * Renders a page document. With `{ ssr: false }` (a route rule), the client
 * renders the page from the shell instead.
 *
 * @param {InertiaPage} page
 * @param {string | undefined} requestUrl
 * @param {ServerReads} serverFetch
 * @param {string | undefined} requestCookies
 * @param {{ ssr?: false }} [options]
 * @returns {Promise<{ html: string, status: number, redirect?: string }>}
 */
export async function renderHtml(
  page,
  requestUrl,
  serverFetch,
  requestCookies,
  options = {},
) {
  const devServer = await developmentServer();
  const rawTemplate = devServer
    ? readFileSync(SOURCE_TEMPLATE_PATH, "utf8")
    : productionHtmlTemplate();
  const template = devServer
    ? await devServer.transformIndexHtml(requestUrl, rawTemplate)
    : rawTemplate;
  const rendered =
    options.ssr === false
      ? clientRenderedShell(page)
      : await serverRendered(page, serverFetch, requestCookies, devServer);
  if (rendered.redirect)
    return { html: "", status: 200, redirect: rendered.redirect };
  const headEnd =
    (await documentStyleTags(devServer, rendered.modules, template)) +
    (devServer ? "" : localeCatalogPreloadTag(rendered.catalogLocale)) +
    publicOptionsScript();
  const html = template
    .replace("<title>Antelope DMS</title>", () =>
      withFaviconPlaceholder(rendered.head.headTags),
    )
    .replace(/<html([^>]*)>/, (_, /** @type {string} */ attributes) =>
      htmlTag(attributes, rendered.head.htmlAttrs),
    )
    .replace("<body", `<body ${rendered.head.bodyAttrs}`)
    .replace("</head>", `${headEnd}</head>`)
    .replace(
      '<div id="dms-overlays" class="isolate"></div>',
      `<div id="dms-overlays" class="isolate">${rendered.overlays}</div>`,
    )
    .replace("__DMS_APP__", () => rendered.body);
  return { html, status: rendered.error?.statusCode ?? 200 };
}

/**
 * @param {InertiaPage} page
 * @param {IncomingMessage} request
 * @param {Pick<import("./server/route-rules.mjs").RouteRule, "ssr">} [rule]
 * @param {ServerReads} [reads]
 */
function renderRequestHtml(page, request, rule = {}, reads) {
  const fetch = reads ?? serverComponentFetch(request);
  return renderHtml(page, request.url, fetch, request.headers.cookie, {
    ssr: rule.ssr,
  });
}

/**
 * Renders a page document, at the query the page completes as it renders:
 * see `renderInPlace`.
 *
 * @param {InertiaPage} page
 * @param {IncomingMessage} request
 * @param {import("./server/route-rules.mjs").MergedRouteRule} rule
 * @param {import("./server/page-props.mjs").PageAuth} auth
 */
function renderDocument(page, request, rule, auth) {
  const fetch = serverComponentFetch(request);
  return renderInPlace(
    request,
    page,
    fetch,
    (served) => renderRequestHtml(served, request, rule, fetch),
    (props, url) => propsForQuery(props, url, pageBackend(request), auth),
  );
}

/**
 * @param {unknown} error
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 */
async function writeBackendError(error, request, response) {
  const auth = await currentAuth();
  const status = requestFailure.failureStatus(error);
  const pathname = new URL(request.url, "http://frontend.local").pathname;
  if (
    error instanceof BackendResponseError &&
    [401, 403].includes(status) &&
    !readSession(request) &&
    !auth.isSignInExempt(pathname)
  ) {
    redirectFrontendVisit(request, response, auth.signInLocation(request.url));
    return;
  }
  const loadRenderer = async () => ssrRenderer(await developmentServer());
  if (await redirectAccessRefusal(error, request, response, loadRenderer))
    return;
  console.error("DMS backend request failed", error);
  if (isFrontendVisit(request)) {
    const props = {
      path: pathname,
      page: {},
      ...auth.view(readSession(request)),
      error: { statusCode: status },
    };
    const page = createInertiaPage(request.url, props);
    if (request.headers[INERTIA_HEADER]) {
      return writeContent(
        request,
        response,
        status,
        inertiaHeaders(page.version),
        JSON.stringify(page),
      );
    }
    const { html } = await renderRequestHtml(page, request);
    return writeContent(request, response, status, htmlHeaders(), html);
  }
  const payload =
    error instanceof UpstreamError || error instanceof RequestBodyError
      ? { message: error.message }
      : UNEXPECTED_ERROR_BODY;
  response.writeHead(status, { "content-type": JSON_TYPE });
  response.end(JSON.stringify(payload));
}

/**
 * @param {ViteDevServer} devServer
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @returns {Promise<boolean>}
 */
async function answeredByVite(devServer, request, response) {
  const result = await runViteMiddlewares(devServer, request, response);
  if (result.status === "failed") writeViteError(response, result.error);
  return result.status !== "unhandled";
}

/**
 * Whether the renderer has a file at `pathname`: a development source Vite
 * serves (under the workspace or its `public/`), or a built asset the
 * production server serves. Only a path with an extension names one.
 *
 * The path is decoded as Vite and the asset server read it: `%2E` is a dot.
 *
 * @param {ViteDevServer | undefined} devServer
 * @param {string} requested
 * @returns {boolean}
 */
function hasRendererFile(devServer, requested) {
  let pathname;
  try {
    pathname = decodeURIComponent(requested);
  } catch {
    return false;
  }
  if (extname(pathname) === "") return false;
  if (!devServer) return publicBuildFile(CLIENT_ROOT, requested) !== undefined;
  const roots = [devServer.config.root, devServer.config.publicDir].filter(
    Boolean,
  );
  return roots.some((root) => {
    const file = resolve(root, `.${pathname}`);
    return (
      file.startsWith(`${resolve(root)}${sep}`) &&
      existsSync(file) &&
      statSync(file).isFile()
    );
  });
}

/**
 * Vite's files in development, the build's in production; else a 404.
 *
 * @param {ViteDevServer | undefined} devServer
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @param {string} pathname
 * @returns {Promise<void>}
 */
async function serveRendererFile(devServer, request, response, pathname) {
  const answered = devServer
    ? await answeredByVite(devServer, request, response)
    : serveAsset(pathname, request, response);
  if (answered) return;
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}

/** @param {ServerResponse} response */
function writeNotFound(response) {
  response.writeHead(404, { "content-type": JSON_TYPE });
  response.end(JSON.stringify({ message: "Not found" }));
}

/**
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 */
export async function handleRequest(request, response) {
  const url = new URL(request.url, "http://frontend.local");
  const pathname = url.pathname;
  const localRoute = LOCAL_ROUTES.find(([matches]) => matches(pathname));
  if (localRoute) return localRoute[1](request, response);
  const devServer = await developmentServer();
  const modules = await loadServerModules(devServer);
  /** @param {string} path */
  const hasFile = (path) => hasRendererFile(devServer, path);
  const owner = requestOwner(request.method, pathname, modules, hasFile);
  if (devServer) response.setHeader("x-dms-route-owner", ownerLabel(owner));
  if (owner.kind === "renderer")
    return serveRendererFile(devServer, request, response, pathname);
  if (owner.kind === "module")
    return handleModuleRoute(request, response, pathname, modules);
  /** @param {string} path */
  const isProxiedPath = (path) => reachesBackend(path, modules, hasFile);
  if (owner.kind === "backend")
    return proxy(request, response, owner.proxy, isProxiedPath);
  if (owner.kind === "not-found") return writeNotFound(response);
  if (requestFailure.hasMalformedPath(request.url))
    return requestFailure.writeBadRequest(response);
  if (handleAssetVersionMismatch(request, response)) return;
  if (redirectToHomepage(request, response, pathname)) return;
  const { serverAuth: auth, rules } = modules;
  const { props, onceProps } = await pageProps(request, auth);
  if (redirectSignedOutPrivatePage(request, response, props, auth)) return;
  const page = createInertiaPage(request.url, props, undefined, onceProps);
  const rule = routeRuleFor(rules, pathname);
  /** @param {number} status */
  const headersFor = (status) =>
    ruleHeaders(rule, request, pageRoute(props), status);
  if (request.headers[INERTIA_HEADER]) {
    return writeContent(
      request,
      response,
      200,
      { ...inertiaHeaders(page.version), ...headersFor(200) },
      JSON.stringify(page),
    );
  }
  const { rendered, served } = await renderDocument(page, request, rule, auth);
  if (rendered.redirect) {
    redirectFrontendVisit(request, response, rendered.redirect);
    return;
  }
  const location = served === page ? {} : { "content-location": served.url };
  return writeContent(
    request,
    response,
    rendered.status,
    { ...htmlHeaders(), ...headersFor(rendered.status), ...location },
    rendered.html,
  );
}

/**
 * @param {unknown} error
 * @param {IncomingMessage & { dmsSessionRetry?: boolean }} request
 * @param {ServerResponse} response
 */
async function writeRequestFailure(error, request, response) {
  if (requestFailure.isResponseGone(error, response)) return;
  if (
    error instanceof BackendResponseError &&
    error.status === 401 &&
    request.method === "GET" &&
    readSession(request) &&
    !request.dmsSessionRetry
  ) {
    request.dmsSessionRetry = true;
    if (await (await currentAuth()).refresh(request, response)) {
      await handleRequestSafely(request, response);
      return;
    }
  }
  await writeBackendError(error, request, response);
}

/**
 * An error page failing too must not reject: that would end the process.
 *
 * @param {IncomingMessage} request
 * @param {ServerResponse} response
 * @returns {Promise<void>}
 */
export async function handleRequestSafely(request, response) {
  try {
    if (refuseForeignTarget(request, response)) return;
    await handleRequest(request, response);
  } catch (error) {
    await writeRequestFailure(error, request, response).catch((failure) =>
      requestFailure.abandonResponse(failure, response),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  frontendHttpServer = createServer(SERVER_OPTIONS, handleRequestSafely);
  frontendHttpServer.on("clientError", (error, socket) =>
    handleClientError(error, socket, maxHeaderSize),
  );
  const port = Number(process.env.PORT ?? 3001);
  const host = listenHost();
  /** @param {NodeJS.ErrnoException} error */
  const onListenError = (error) => void reportListenError(error, host, port);
  frontendHttpServer.once("error", onListenError);
  frontendHttpServer.listen(port, host, () => {
    frontendHttpServer.off("error", onListenError);
    void announceReady();
  });
}

/** Prints who owns which paths, once the server is up. */
async function reportRouting() {
  try {
    const modules = await loadServerModules(await developmentServer());
    for (const line of routingReport(modules.proxies, modules.routes.length))
      console.log(line);
  } catch (error) {
    console.error("DMS server modules failed to load", error);
  }
}

/**
 * Report the server ready. In development Vite would otherwise start with the
 * first request, so it is started here: "ready" then means the first page is
 * served without that wait.
 *
 * Only the production build produces the email bundle otherwise. The watcher
 * starts once the server answers, so it never delays the first page.
 */
async function announceReady() {
  try {
    await developmentServer();
  } catch (error) {
    await reportStartError(error);
    return;
  }
  const { address, port } = frontendHttpServer.address();
  await reportReady(address, port);
  await reportRouting();
  if (process.env.DMS_DEV === "true") watchEmailBundle();
}
