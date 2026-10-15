import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, maxHeaderSize } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { ofetch } from "ofetch";
import {
  relayedHeaders,
  RequestBodyError,
  UpstreamError,
} from "./server/auth/backend.mjs";
import { proxyAccess, refuseCrossOrigin } from "./server/public-endpoints.mjs";
import { readSession } from "./server/auth/session.mjs";
import {
  BackendResponseError,
  backendResponseError,
  redirectAccessRefusal,
  UNEXPECTED_ERROR_BODY,
} from "./server/backend-response.mjs";
import { handleClientError } from "./server/client-error.mjs";
import {
  reportListenError,
  reportReady,
  reportStartError,
} from "./server/cli-report.mjs";
import { productionHtmlTemplate } from "./server/client-manifest.mjs";
import { writeContent } from "./server/content.mjs";
import {
  captureViteErrors,
  runViteMiddlewares,
  writeViteError,
} from "./server/vite-errors.mjs";
import { documentStyleTags } from "./server/dev-styles.mjs";
import { watchEmailBundle } from "./server/email.mjs";
import { DEV_FS_DENY, denyPrivateFiles } from "./server/dev-private-files.mjs";
import { ownerLabel, requestOwner } from "./server/request-routing.mjs";
import { routingReport } from "./server/backend-proxies.mjs";
import { routeRuleFor, ruleHeaders } from "./server/route-rules.mjs";
import {
  handleModuleRoute,
  loadServerModules,
} from "./server/module-server.mjs";
import { HOMEPAGE } from "./server/homepage.mjs";
import { loadPageProps } from "./server/page-props.mjs";
import { htmlTag } from "./server/html-tag.mjs";
import { listenHost } from "./server/listen-host.mjs";
import * as icons from "./server/icons.mjs";
import * as requestFailure from "./server/request-failure.mjs";
import { writeProxyHeaders } from "./server/proxy-headers.mjs";
import { backendUrl, refuseForeignTarget } from "./server/request-target.mjs";
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

const INERTIA_HEADER = "x-inertia";
const JSON_TYPE = "application/json";
const PROJECT_ROOT = fileURLToPath(new URL(".", import.meta.url));
const MIME_TYPES = {
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml",
};
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const LOCAL_ROUTES = [[icons.isIconRequest, icons.handleIcons]];
const SOURCE_TEMPLATE_PATH = join(PROJECT_ROOT, "index.html");
const BUILT_SSR_RENDERER_PATH = join(PROJECT_ROOT, "dist/ssr/ssr-renderer.js");
// The SSR bundle keeps vue-i18n external, so Node loads its esm-bundler build,
// which reads compile-time flags only a bundler replaces. Vite inlines them in
// the client bundle; without the same value here, installing vue-i18n under
// NODE_ENV=production throws a ReferenceError on the first render.
globalThis.__VUE_PROD_DEVTOOLS__ ??= false;
let productionSsrRenderer;
let vite;
let vitePromise;
let frontendHttpServer;

async function developmentServer() {
  if (process.env.DMS_DEV !== "true") return undefined;
  if (vite) return vite;
  vitePromise ??= import("vite")
    .then(({ createServer: createViteServer }) => {
      const serverOptions = {
        middlewareMode: true,
        // The generated secrets and the modules' server code, never served.
        fs: { deny: DEV_FS_DENY },
      };
      if (frontendHttpServer)
        serverOptions.hmr = { server: frontendHttpServer };
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

/**
 * The headers of a backend request: the relayed client headers, and the
 * session's access token unless the request goes anonymously.
 */
function backendHeaders(request, access = { anonymous: false, headers: [] }) {
  const headers = relayedHeaders(request, [
    "accept",
    "content-type",
    "if-match",
    "user-agent",
    "x-content-language",
    "x-realtime-session",
    ...access.headers,
  ]);
  const session = access.anonymous ? undefined : readSession(request);
  if (session?.accessToken)
    headers.authorization = `Bearer ${session.accessToken}`;
  return headers;
}

function serverComponentFetch(request) {
  return (path, options = {}) => {
    const headers = new Headers(backendHeaders(request));
    new Headers(options.headers).forEach((value, name) => {
      headers.set(name, value);
    });
    return ofetch(path, {
      ...options,
      baseURL: process.env.DMS_API_BASE_URL,
      headers,
    });
  };
}

async function backendJson(path, request) {
  const response = await fetch(new URL(path, process.env.DMS_API_BASE_URL), {
    headers: backendHeaders(request),
  });
  if (!response.ok) {
    throw await backendResponseError(response);
  }
  return response.json();
}

/** The session logic of the module that owns sign-in. */
async function currentAuth() {
  return (await loadServerModules(await developmentServer())).serverAuth;
}

function pageProps(request, auth) {
  return loadPageProps(
    request,
    {
      fetchJson: (path) => backendJson(path, request),
      isFrontendPage: async (pathname) =>
        (await ssrRenderer(await developmentServer())).isDmsFrontendPage(
          pathname,
        ),
    },
    auth,
  );
}

function redirectToHomepage(request, response, pathname) {
  if (pathname !== "/" || HOMEPAGE === "/") return false;
  redirectFrontendVisit(request, response, HOMEPAGE);
  return true;
}

function redirectSignedOutPrivatePage(request, response, props, auth) {
  const route = props.page?.route;
  if (
    route?.publicAccess === true ||
    route?.hasAccess !== false ||
    readSession(request)
  )
    return false;
  redirectFrontendVisit(request, response, auth.signInLocation(request.url));
  return true;
}

/** Sends a request to the backend through the proxy it reached. */
async function proxy(request, response, backendProxy) {
  const access = proxyAccess(request, SAFE_METHODS, backendProxy);
  if (access.isRefused) {
    refuseCrossOrigin(response);
    return true;
  }
  // Cancelling the body alone misses a client that leaves before the backend
  // answers: its stream, an SSE feed above all, then stayed open for good.
  const abandoned = new AbortController();
  response.once("close", () => abandoned.abort());
  const upstream = await fetch(backendUrl(request.url), {
    signal: abandoned.signal,
    method: request.method,
    headers: backendHeaders(request, access),
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request,
    duplex: "half",
  });
  writeProxyHeaders(response, upstream);
  if (!upstream.body || request.method === "HEAD") response.end();
  else await pipeline(Readable.fromWeb(upstream.body), response);
}

function acceptedAsset(pathname, request) {
  const file = resolve(PROJECT_ROOT, "dist/client", `.${pathname}`);
  const accepted = request.headers["accept-encoding"] ?? "";
  if (accepted.includes("br") && existsSync(`${file}.br`))
    return { file: `${file}.br`, encoding: "br", source: file };
  if (accepted.includes("gzip") && existsSync(`${file}.gz`))
    return { file: `${file}.gz`, encoding: "gzip", source: file };
  return { file, encoding: undefined, source: file };
}

function serveAsset(pathname, request, response) {
  const selected = acceptedAsset(pathname, request);
  // Native separator: `selected.source` comes from `resolve`, so a hardcoded
  // `/` here would make the containment check fail for every asset on Windows.
  const assetRoot = `${resolve(PROJECT_ROOT, "dist/client")}${sep}`;
  if (
    !selected.source.startsWith(assetRoot) ||
    !existsSync(selected.file) ||
    !statSync(selected.file).isFile()
  )
    return false;
  const headers = {
    "cache-control": pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "content-type":
      MIME_TYPES[extname(selected.source)] ?? "application/octet-stream",
    "content-length": statSync(selected.file).size,
    vary: "Accept-Encoding",
  };
  if (selected.encoding) headers["content-encoding"] = selected.encoding;
  response.writeHead(200, headers);
  createReadStream(selected.file).pipe(response);
  return true;
}

async function ssrRenderer(devServer) {
  const renderer = devServer
    ? await devServer.ssrLoadModule("/ssr-renderer.ts")
    : await (productionSsrRenderer ??= import(BUILT_SSR_RENDERER_PATH));
  await icons.provideIconCollections(renderer);
  return renderer;
}

function clientRenderedShell(page) {
  return {
    body: inertiaAppHtml(page),
    head: { headTags: "", htmlAttrs: "", bodyAttrs: "" },
    overlays: "",
  };
}

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
  const preloads = await documentStyleTags(devServer, page, template);
  const html = template
    .replace("<title>Antelope DMS</title>", rendered.head.headTags)
    .replace(/<html([^>]*)>/, (_, attributes) =>
      htmlTag(attributes, rendered.head.htmlAttrs),
    )
    .replace("<body", `<body ${rendered.head.bodyAttrs}`)
    .replace("</head>", `${preloads}</head>`)
    .replace(
      '<div id="dms-overlays" class="isolate"></div>',
      `<div id="dms-overlays" class="isolate">${rendered.overlays}</div>`,
    )
    .replace("__DMS_APP__", () => rendered.body);
  return { html, status: rendered.error?.statusCode ?? 200 };
}

function renderRequestHtml(page, request, rule = {}) {
  const fetch = serverComponentFetch(request);
  return renderHtml(page, request.url, fetch, request.headers.cookie, {
    ssr: rule.ssr,
  });
}

async function writeBackendError(error, request, response) {
  const auth = await currentAuth();
  const status = Number.isInteger(error?.status) ? error.status : 502;
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

async function answeredByVite(devServer, request, response) {
  const result = await runViteMiddlewares(devServer, request, response);
  if (result.status === "failed") writeViteError(response, result.error);
  return result.status !== "unhandled";
}

/**
 * Whether the renderer has a file at `pathname`: a development source Vite
 * serves (under the workspace or its `public/`), or a built asset. Only a
 * path with an extension names one.
 */
function hasRendererFile(devServer, requested) {
  let pathname;
  try {
    // As Vite and the asset server read it: `%2E` is a dot.
    pathname = decodeURIComponent(requested);
  } catch {
    return false;
  }
  if (extname(pathname) === "") return false;
  const roots = devServer
    ? [devServer.config.root, devServer.config.publicDir].filter(Boolean)
    : [join(PROJECT_ROOT, "dist/client")];
  return roots.some((root) => {
    const file = resolve(root, `.${pathname}`);
    return (
      file.startsWith(`${resolve(root)}${sep}`) &&
      existsSync(file) &&
      statSync(file).isFile()
    );
  });
}

/** Vite's files in development, the build's in production; else a 404. */
async function serveRendererFile(devServer, request, response, pathname) {
  const answered = devServer
    ? await answeredByVite(devServer, request, response)
    : serveAsset(pathname, request, response);
  if (answered) return;
  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}

function writeNotFound(response) {
  response.writeHead(404, { "content-type": JSON_TYPE });
  response.end(JSON.stringify({ message: "Not found" }));
}

export async function handleRequest(request, response) {
  const url = new URL(request.url, "http://frontend.local");
  const pathname = url.pathname;
  const localRoute = LOCAL_ROUTES.find(([matches]) => matches(pathname));
  if (localRoute) return localRoute[1](request, response);
  const devServer = await developmentServer();
  const modules = await loadServerModules(devServer);
  const owner = requestOwner(request.method, pathname, modules, (path) =>
    hasRendererFile(devServer, path),
  );
  if (devServer) response.setHeader("x-dms-route-owner", ownerLabel(owner));
  if (owner.kind === "renderer")
    return serveRendererFile(devServer, request, response, pathname);
  if (owner.kind === "module")
    return handleModuleRoute(request, response, pathname, modules);
  if (owner.kind === "backend") return proxy(request, response, owner.proxy);
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
  const headersFor = (status) =>
    ruleHeaders(rule, request, props.page?.route, status);
  if (request.headers[INERTIA_HEADER]) {
    return writeContent(
      request,
      response,
      200,
      { ...inertiaHeaders(page.version), ...headersFor(200) },
      JSON.stringify(page),
    );
  }
  const rendered = await renderRequestHtml(page, request, rule);
  if (rendered.redirect) {
    redirectFrontendVisit(request, response, rendered.redirect);
    return;
  }
  return writeContent(
    request,
    response,
    rendered.status,
    { ...htmlHeaders(), ...headersFor(rendered.status) },
    rendered.html,
  );
}

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

export async function handleRequestSafely(request, response) {
  try {
    if (refuseForeignTarget(request, response)) return;
    await handleRequest(request, response);
  } catch (error) {
    // An error page failing too must not reject: that would end the process.
    await writeRequestFailure(error, request, response).catch((failure) =>
      requestFailure.abandonResponse(failure, response),
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  frontendHttpServer = createServer(handleRequestSafely);
  frontendHttpServer.on("clientError", (error, socket) =>
    handleClientError(error, socket, maxHeaderSize),
  );
  const port = Number(process.env.PORT ?? 3001);
  const host = listenHost();
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
  // Only the production build produces the email bundle otherwise. Started
  // once the server answers, so it never delays the first page.
  if (process.env.DMS_DEV === "true") watchEmailBundle();
}
