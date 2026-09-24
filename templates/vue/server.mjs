import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  createBrotliCompress,
  createGzip,
  constants as zlibConstants,
} from "node:zlib";
import { ofetch } from "ofetch";
import { RequestBodyError, UpstreamError } from "./server/auth/backend.mjs";
import { CROSS_ORIGIN_ERROR, isSameOrigin } from "./server/auth/client-ip.mjs";
import {
  handleAuth,
  publicSession,
  refreshSession,
} from "./server/auth/routes.mjs";
import { readSession } from "./server/auth/session.mjs";
import { productionHtmlTemplate } from "./server/client-manifest.mjs";
import { documentStyleTags } from "./server/dev-styles.mjs";
import { handleEmailRender } from "./server/email.mjs";
import { HOMEPAGE } from "./server/homepage.mjs";
import { handleTester } from "./server/tester.mjs";
import {
  createInertiaPage,
  htmlHeaders,
  inertiaAppHtml,
  inertiaHeaders,
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
const AUTH_PAGE = "/auth";
const ONBOARDING_PAGE = "/onboarding";
const MINIMUM_COMPRESSION_BYTES = 1_024;
const DYNAMIC_BROTLI_QUALITY = 4;
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

class BackendResponseError extends Error {
  constructor(status) {
    super(`DMS backend returned ${status}`);
    this.status = status;
  }
}

async function developmentServer() {
  if (process.env.DMS_DEV !== "true") return undefined;
  if (vite) return vite;
  vitePromise ??= import("vite")
    .then(({ createServer: createViteServer }) => {
      const serverOptions = { middlewareMode: true };
      if (frontendHttpServer)
        serverOptions.hmr = { server: frontendHttpServer };
      return createViteServer({ server: serverOptions, appType: "custom" });
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
    throw new BackendResponseError(response.status);
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

function isFrontendVisit(request) {
  if (request.method !== "GET") return false;
  return (
    Boolean(request.headers[INERTIA_HEADER]) ||
    request.headers.accept?.includes("text/html")
  );
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
  const upstream = await fetch(target, {
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

function responseEncoder(request, content) {
  if (Buffer.byteLength(content) < MINIMUM_COMPRESSION_BYTES) return undefined;
  const accepted = request.headers["accept-encoding"] ?? "";
  if (accepted.includes("br"))
    return {
      encoding: "br",
      stream: createBrotliCompress({
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: DYNAMIC_BROTLI_QUALITY,
        },
      }),
    };
  if (accepted.includes("gzip"))
    return { encoding: "gzip", stream: createGzip() };
}

async function writeContent(request, response, status, headers, content) {
  const encoder = responseEncoder(request, content);
  const vary = [headers.vary, "Accept-Encoding"].filter(Boolean).join(", ");
  const encodedHeaders = { ...headers, vary };
  if (!encoder) {
    response.writeHead(status, encodedHeaders);
    response.end(content);
    return;
  }
  encodedHeaders["content-encoding"] = encoder.encoding;
  response.writeHead(status, encodedHeaders);
  await pipeline(Readable.from([content]), encoder.stream, response);
}

async function ssrRenderer(devServer) {
  if (devServer) return devServer.ssrLoadModule("/ssr-renderer.ts");
  productionSsrRenderer ??= import(BUILT_SSR_RENDERER_PATH);
  return productionSsrRenderer;
}

export async function renderHtml(page, requestUrl, serverFetch) {
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
    rendered = await renderer.renderDmsPage(page, serverFetch);
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
    .replace("<html", `<html ${rendered.head.htmlAttrs}`)
    .replace("<body", `<body ${rendered.head.bodyAttrs}`)
    .replace("</head>", `${preloads}</head>`)
    .replace(
      '<div id="dms-overlays" class="isolate"></div>',
      `<div id="dms-overlays" class="isolate">${rendered.overlays}</div>`,
    )
    .replace("__DMS_APP__", () => rendered.body);
  return { html, status: rendered.error?.statusCode ?? 200 };
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
  console.error("DMS backend request failed", error);
  if (isFrontendVisit(request)) {
    const statusMessage = "DMS backend request failed";
    const props = {
      path: pathname,
      page: {},
      ...publicSession(readSession(request)),
      error: { statusCode: status, statusMessage, message: statusMessage },
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
    const { html } = await renderHtml(
      page,
      request.url,
      serverComponentFetch(request),
    );
    return writeContent(request, response, status, htmlHeaders(), html);
  }
  const payload =
    error instanceof UpstreamError || error instanceof RequestBodyError
      ? { message: error.message }
      : { error: "DMS backend request failed" };
  response.writeHead(status, { "content-type": JSON_TYPE });
  response.end(JSON.stringify(payload));
}

export async function handleRequest(request, response) {
  const url = new URL(request.url, "http://frontend.local");
  const pathname = url.pathname;
  if (TESTER_ROUTE.test(pathname)) return handleTester(request, response);
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
  if (!isFrontendVisit(request) && (await proxy(request, response, true)))
    return;
  const devServer = await developmentServer();
  if (devServer && pathname !== "/") {
    const handled = await new Promise((resolve) => {
      devServer.middlewares(request, response, () => resolve(false));
      response.once("finish", () => resolve(true));
    });
    if (handled) return;
  }
  if (!devServer && serveAsset(pathname, request, response)) return;
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
  const rendered = await renderHtml(
    page,
    request.url,
    serverComponentFetch(request),
  );
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

export async function handleRequestSafely(request, response) {
  try {
    await handleRequest(request, response);
  } catch (error) {
    if (
      error?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      response.destroyed ||
      response.writableEnded ||
      response.headersSent
    )
      return;
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
}
