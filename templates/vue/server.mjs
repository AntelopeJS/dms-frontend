import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { ofetch } from "ofetch";
import { RequestBodyError, UpstreamError } from "./server/auth/backend.mjs";
import { CROSS_ORIGIN_ERROR, isSameOrigin } from "./server/auth/client-ip.mjs";
import {
  handleAuth,
  publicSession,
  refreshSession,
} from "./server/auth/routes.mjs";
import { readSession } from "./server/auth/session.mjs";
import {
  BackendResponseError,
  backendResponseError,
  redirectAccessRefusal,
  UNEXPECTED_ERROR_BODY,
} from "./server/backend-response.mjs";
import { productionHtmlTemplate } from "./server/client-manifest.mjs";
import { writeContent } from "./server/content.mjs";
import {
  captureViteErrors,
  runViteMiddlewares,
  writeViteError,
} from "./server/vite-errors.mjs";
import { documentStyleTags } from "./server/dev-styles.mjs";
import { handleEmailRender, watchEmailBundle } from "./server/email.mjs";
import { HOMEPAGE } from "./server/homepage.mjs";
import { htmlTag } from "./server/html-tag.mjs";
import { handleIcons, isIconRequest } from "./server/icons.mjs";
import * as requestFailure from "./server/request-failure.mjs";
import { handleTester } from "./server/tester.mjs";
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
const PROXY_PREFIXES = ["/api/", "/dms/"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const AUTH_SERVER_ROUTES = [
  ["GET", /^\/api\/_auth\/session\/?$/],
  ["POST", /^\/api\/_auth\/session\/?$/],
  ["DELETE", /^\/api\/_auth\/session\/?$/],
  [
    "POST",
    /^\/auth\/(?:login|signup|verify-2fa|establish|request-2fa-email|switch-account|switch-tenant|validate-account|remove-account)\/?$/,
  ],
  ["POST", /^\/auth\/oauth\/handoff\/?$/],
  ["GET", /^\/auth\/oauth\/[^/]+\/(?:start|callback)\/?$/],
];
const HTML_RENDER_ROUTE = "/api/html/render";
const TESTER_ROUTE = /^\/api\/_dms\/tester\/?$/;
const LOCAL_ROUTES = [
  [(pathname) => TESTER_ROUTE.test(pathname), handleTester],
  [isIconRequest, handleIcons],
];
const AUTH_PAGE = "/auth";
const ONBOARDING_PAGE = "/onboarding";
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
      const serverOptions = { middlewareMode: true };
      if (frontendHttpServer)
        serverOptions.hmr = { server: frontendHttpServer };
      return createViteServer({
        server: serverOptions,
        appType: "custom",
        plugins: [captureViteErrors()],
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

function backendHeaders(request) {
  const names = [
    "accept",
    "content-type",
    "user-agent",
    "x-content-language",
    "x-realtime-session",
  ];
  const headers = Object.fromEntries(
    names.flatMap((name) =>
      request.headers[name] ? [[name, request.headers[name]]] : [],
    ),
  );
  const session = readSession(request);
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

async function fetchPage(request, pathname) {
  const query = new URLSearchParams({ path: pathname });
  return backendJson(`/dms/page?${query}`, request);
}

async function pageProps(request) {
  const pathname = new URL(request.url, "http://frontend.local").pathname;
  const session = publicSession(readSession(request));
  try {
    const page = await fetchPage(request, pathname);
    return { path: pathname, page, ...session };
  } catch (error) {
    if (!(error instanceof BackendResponseError) || error.status !== 404)
      throw error;
    const renderer = await ssrRenderer(await developmentServer());
    if (!renderer.isDmsFrontendPage(pathname)) throw error;
    return {
      path: pathname,
      ...session,
      page: {
        componentName: pathname,
        isFrontendOnly: true,
        route: {
          fullId: pathname.slice(1).replaceAll("/", "."),
          fullSlug: pathname,
          hasAccess: pathname.startsWith("/auth/"),
        },
        layout: { layout: { componentName: "DefaultLayout" } },
      },
    };
  }
}

function writeProxyHeaders(response, upstream) {
  const headers = Object.fromEntries(upstream.headers);
  delete headers["set-cookie"];
  const cookies = upstream.headers.getSetCookie?.() ?? [];
  if (cookies.length) headers["set-cookie"] = cookies;
  response.writeHead(upstream.status, headers);
}

function redirectToHomepage(request, response, pathname) {
  if (pathname !== "/" || HOMEPAGE === "/") return false;
  redirectFrontendVisit(request, response, HOMEPAGE);
  return true;
}

function redirectSignedOutPrivatePage(request, response, props) {
  const route = props.page?.route;
  if (
    route?.publicAccess === true ||
    route?.hasAccess !== false ||
    readSession(request)
  )
    return false;
  const location = `${AUTH_PAGE}?redirect=${encodeURIComponent(request.url)}`;
  redirectFrontendVisit(request, response, location);
  return true;
}

export function requestOwnership(method, pathname) {
  if (PROXY_PREFIXES.some((prefix) => pathname.startsWith(prefix)))
    return "server";
  if (
    AUTH_SERVER_ROUTES.some(
      ([routeMethod, pattern]) =>
        routeMethod === method && pattern.test(pathname),
    )
  )
    return "server";
  return method === "GET" ? "frontend" : "server";
}

async function proxy(request, response, fallbackOnNotFound = false) {
  if (!SAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
    response.writeHead(403, { "content-type": JSON_TYPE });
    response.end(JSON.stringify(CROSS_ORIGIN_ERROR));
    return true;
  }
  const target = new URL(request.url, process.env.DMS_API_BASE_URL);
  // Cancelling the body alone misses a client that leaves before the backend
  // answers: its stream, an SSE feed above all, then stayed open for good.
  const abandoned = new AbortController();
  response.once("close", () => abandoned.abort());
  const upstream = await fetch(target, {
    signal: abandoned.signal,
    method: request.method,
    headers: backendHeaders(request),
    body: ["GET", "HEAD"].includes(request.method) ? undefined : request,
    duplex: "half",
  });
  if (fallbackOnNotFound && upstream.status === 404) {
    await upstream.body?.cancel();
    return false;
  }
  writeProxyHeaders(response, upstream);
  if (!upstream.body || request.method === "HEAD") response.end();
  else await pipeline(Readable.fromWeb(upstream.body), response);
  return true;
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
  if (devServer) return devServer.ssrLoadModule("/ssr-renderer.ts");
  productionSsrRenderer ??= import(BUILT_SSR_RENDERER_PATH);
  return productionSsrRenderer;
}

export async function renderHtml(
  page,
  requestUrl,
  serverFetch,
  requestCookies,
) {
  const devServer = await developmentServer();
  const rawTemplate = devServer
    ? readFileSync(SOURCE_TEMPLATE_PATH, "utf8")
    : productionHtmlTemplate();
  const template = devServer
    ? await devServer.transformIndexHtml(requestUrl, rawTemplate)
    : rawTemplate;
  let rendered;
  try {
    const renderer = await ssrRenderer(devServer);
    rendered = await renderer.renderDmsPage(page, serverFetch, requestCookies);
  } catch (error) {
    console.error(
      "DMS SSR render failed; falling back to client rendering",
      error,
    );
    rendered = {
      body: inertiaAppHtml(page),
      head: { headTags: "", htmlAttrs: "", bodyAttrs: "" },
      overlays: "",
      error: { statusCode: 500 },
    };
  }
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

function renderRequestHtml(page, request) {
  const fetch = serverComponentFetch(request);
  return renderHtml(page, request.url, fetch, request.headers.cookie);
}

async function writeBackendError(error, request, response) {
  const status = Number.isInteger(error?.status) ? error.status : 502;
  const pathname = new URL(request.url, "http://frontend.local").pathname;
  if (
    error instanceof BackendResponseError &&
    [401, 403].includes(status) &&
    !readSession(request) &&
    !pathname.startsWith(AUTH_PAGE) &&
    pathname !== ONBOARDING_PAGE
  ) {
    const location = `${AUTH_PAGE}?redirect=${encodeURIComponent(request.url)}`;
    redirectFrontendVisit(request, response, location);
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
      ...publicSession(readSession(request)),
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
 * Vite's own URLs (`/@vite/client`, `/@id/…`, `/@fs/…`) and paths with an
 * extension name files: modules, stylesheets, fonts, images, built assets.
 * The backend's routes outside `/api` and `/dms` are mostly the paths of the
 * pages they serve data for, which have none (`/<page>/pagelayout`).
 */
function isFilePath(pathname) {
  return pathname.startsWith("/@") || extname(pathname) !== "";
}

/** Vite's files in development, the build's in production. */
async function answeredWithFile(devServer, request, response, pathname) {
  if (!devServer) return serveAsset(pathname, request, response);
  return pathname !== "/" && answeredByVite(devServer, request, response);
}

export async function handleRequest(request, response) {
  const url = new URL(request.url, "http://frontend.local");
  const pathname = url.pathname;
  const localRoute = LOCAL_ROUTES.find(([matches]) => matches(pathname));
  if (localRoute) return localRoute[1](request, response);
  if (pathname === "/api/_auth/session")
    return handleAuth(request, response, url);
  if (request.method === "POST" && pathname === HTML_RENDER_ROUTE)
    return handleEmailRender(request, response);
  if (
    AUTH_SERVER_ROUTES.some(
      ([method, pattern]) =>
        method === request.method && pattern.test(pathname),
    )
  )
    return handleAuth(request, response, url);
  if (requestOwnership(request.method, pathname) === "server")
    return proxy(request, response);
  if (requestFailure.hasMalformedPath(request.url))
    return requestFailure.writeBadRequest(response);
  const devServer = await developmentServer();
  const visit = isFrontendVisit(request);
  // A file is looked for among the frontend's own before the backend is asked
  // for it: asking first cost a backend round trip for each of the hundreds of
  // modules a development page loads, and for each built asset. A file the
  // frontend does not have, a media file, is still the backend's.
  const fileFirst = !visit && isFilePath(pathname);
  const serveFile = () =>
    answeredWithFile(devServer, request, response, pathname);
  if (fileFirst && (await serveFile())) return;
  if (!visit && (await proxy(request, response, true))) return;
  if (!fileFirst && (await serveFile())) return;
  if (handleAssetVersionMismatch(request, response)) return;
  if (redirectToHomepage(request, response, pathname)) return;
  const props = await pageProps(request);
  if (redirectSignedOutPrivatePage(request, response, props)) return;
  const page = createInertiaPage(request.url, props);
  if (request.headers[INERTIA_HEADER]) {
    return writeContent(
      request,
      response,
      200,
      inertiaHeaders(page.version),
      JSON.stringify(page),
    );
  }
  const rendered = await renderRequestHtml(page, request);
  if (rendered.redirect) {
    redirectFrontendVisit(request, response, rendered.redirect);
    return;
  }
  return writeContent(
    request,
    response,
    rendered.status,
    htmlHeaders(),
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
    if (await refreshSession(request, response)) {
      await handleRequestSafely(request, response);
      return;
    }
  }
  await writeBackendError(error, request, response);
}

export async function handleRequestSafely(request, response) {
  try {
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
  frontendHttpServer.listen(
    Number(process.env.PORT ?? 3001),
    process.env.HOST ?? "0.0.0.0",
    announceReady,
  );
}

/**
 * Print the line the CLI's "Starting … server" announcement waits for. In
 * development Vite would otherwise start with the first request, so it is
 * started here: "ready" then means the first page is served without that wait.
 */
async function announceReady() {
  try {
    await developmentServer();
  } catch (error) {
    console.error("DMS development server failed to start", error);
    return;
  }
  const { address, port } = frontendHttpServer.address();
  const host = ["0.0.0.0", "::"].includes(address)
    ? "localhost"
    : address.includes(":")
      ? `[${address}]`
      : address;
  console.log(`✓ Server ready on http://${host}:${port}`);
  // Only the production build produces the email bundle otherwise. Started
  // once the server answers, so it never delays the first page.
  if (process.env.DMS_DEV === "true") watchEmailBundle();
}
