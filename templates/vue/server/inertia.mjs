import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLIENT_MANIFEST_PATH = fileURLToPath(
  new URL("../dist/client/.vite/manifest.json", import.meta.url),
);
let productionAssetVersion;

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

export function createInertiaPage(url, props, version = assetVersion()) {
  return {
    component: "DmsDynamicPage",
    props: { ...props, errors: props?.errors ?? {} },
    url,
    version,
  };
}

export function inertiaHeaders(version = assetVersion()) {
  return {
    "content-type": "application/json",
    "x-inertia": "true",
    vary: "X-Inertia",
    "x-inertia-version": version,
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
