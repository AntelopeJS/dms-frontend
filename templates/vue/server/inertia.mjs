import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_MANIFEST_PATH = fileURLToPath(
  new URL("../dist/client/.vite/manifest.json", import.meta.url),
);
let productionAssetVersion;

/**
 * Every document and Inertia payload this server writes carries the visitor's
 * own session: the user, the session, and the page tree their permissions
 * allow. `private` is what keeps a shared cache from ever holding it;
 * `no-cache` keeps the browser's own copy from being reused without asking us
 * first, so a revoked session cannot resurface from disk. We stop short of
 * `no-store`, which would additionally forfeit the back-forward cache on every
 * page of a dashboard people navigate constantly.
 */
export const PRIVATE_CACHE_CONTROL = "private, no-cache";

export function assetVersion() {
  if (process.env.DMS_DEV === "true" || !existsSync(CLIENT_MANIFEST_PATH))
    return "development";
  productionAssetVersion ??= createHash("sha256")
    .update(readFileSync(CLIENT_MANIFEST_PATH))
    .digest("hex");
  return productionAssetVersion;
}

export function inertiaAppHtml(page) {
  const serialized = JSON.stringify(page).replaceAll("/", "\\/");
  return `<script data-page="app" type="application/json">${serialized}</script><div id="app"></div>`;
}

/** The one Inertia component every DMS page renders through. */
export const DMS_PAGE_COMPONENT = "DmsDynamicPage";

export function createInertiaPage(
  url,
  props,
  version = assetVersion(),
  onceProps,
) {
  const page = {
    component: DMS_PAGE_COMPONENT,
    props: { ...props, errors: props?.errors ?? {} },
    url,
    version,
  };
  if (onceProps) page.onceProps = onceProps;
  return page;
}

function headerList(request, name) {
  return String(request.headers[name] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Which top-level props a request asks for. A full visit asks for all of them.
 * A partial reload (`router.reload({ only, except })`) of the page on screen
 * names them: a nested path selects its top-level prop, which is sent whole,
 * and only a top-level name excludes one.
 */
export function requestedProps(request) {
  const partial =
    Boolean(request.headers["x-inertia"]) &&
    request.headers["x-inertia-partial-component"] === DMS_PAGE_COMPONENT;
  if (!partial) return { partial, wants: () => true };
  const only = new Set(
    headerList(request, "x-inertia-partial-data").map(
      (path) => path.split(".")[0],
    ),
  );
  const except = new Set(headerList(request, "x-inertia-partial-except"));
  return {
    partial,
    wants: (prop) => (only.size === 0 || only.has(prop)) && !except.has(prop),
  };
}

/** The once props the browser already holds, unexpired, by key. */
export function heldOnceProps(request) {
  return new Set(headerList(request, "x-inertia-except-once-props"));
}

export function inertiaHeaders(version = assetVersion()) {
  return {
    "cache-control": PRIVATE_CACHE_CONTROL,
    "content-type": "application/json",
    "x-inertia": "true",
    vary: "X-Inertia",
    "x-inertia-version": version,
  };
}

/** Headers for a rendered document: same cache stance as an Inertia payload. */
export function htmlHeaders() {
  return {
    "cache-control": PRIVATE_CACHE_CONTROL,
    "content-type": "text/html",
    vary: "X-Inertia",
  };
}

export function handleAssetVersionMismatch(request, response) {
  if (
    !request.headers["x-inertia"] ||
    !request.headers["x-inertia-version"] ||
    request.headers["x-inertia-version"] === assetVersion()
  )
    return false;
  response.writeHead(409, {
    vary: "X-Inertia",
    "x-inertia-location": request.url,
    "x-inertia-version": assetVersion(),
  });
  response.end();
  return true;
}

/** A page visit: a document or Inertia request, as opposed to an API call. */
export function isFrontendVisit(request) {
  if (request.method !== "GET") return false;
  return (
    Boolean(request.headers["x-inertia"]) ||
    request.headers.accept?.includes("text/html")
  );
}

export function redirectFrontendVisit(request, response, location) {
  const vary = { vary: "X-Inertia" };
  if (!request.headers["x-inertia"]) {
    response.writeHead(request.method === "GET" ? 302 : 303, {
      ...vary,
      location,
    });
  } else if (location.includes("#") && !request.headers["x-inertia-prefetch"]) {
    response.writeHead(409, { ...vary, "x-inertia-redirect": location });
  } else if (
    new URL(location, "http://frontend.local").origin !==
    "http://frontend.local"
  ) {
    response.writeHead(409, { ...vary, "x-inertia-location": location });
  } else {
    response.writeHead(request.method === "GET" ? 302 : 303, {
      ...vary,
      location,
    });
  }
  response.end();
}
