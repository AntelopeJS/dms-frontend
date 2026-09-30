import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getIcons } from "@iconify/utils";
import { ICON_API_PATH } from "../icon-api.mjs";
import { writeContent } from "./content.mjs";

const WORKSPACE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const JSON_TYPE = "application/json";
const READ_METHODS = new Set(["GET", "HEAD"]);
// Iconify's own naming rule, for prefixes and icon names alike. It is also
// what keeps a request from naming anything but a collection file.
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COLLECTION_FILE = /^([^/]+)\.json$/;
const ICON_NAME_SEPARATOR = ",";
// An icon's data only changes with the installed collection, which a
// deployment replaces; a week bounds how long an upgraded icon can lag.
const ICON_CACHE_CONTROL =
  "public, max-age=604800, stale-while-revalidate=86400";
const ERROR_CACHE_CONTROL = "no-store";
const collections = new Map();

function collectionSpecifiers(prefix) {
  return [
    `@iconify-json/${prefix}/icons.json`,
    `@iconify/json/json/${prefix}.json`,
  ];
}

function resolveCollectionFile(root, prefix) {
  const require = createRequire(join(root, "package.json"));
  for (const specifier of collectionSpecifiers(prefix)) {
    try {
      return require.resolve(specifier);
    } catch {
      // Not installed under this name: try the next source.
    }
  }
  return undefined;
}

async function loadCollection(root, prefix) {
  const file = resolveCollectionFile(root, prefix);
  if (!file) return undefined;
  return JSON.parse(await readFile(file, "utf8"));
}

/**
 * Parsed once per collection: a collection file is several megabytes, and
 * one page asks for icons of the same few collections many times.
 */
function collection(root, prefix) {
  const key = join(root, prefix);
  if (!collections.has(key)) {
    const loading = loadCollection(root, prefix);
    loading.catch(() => collections.delete(key));
    collections.set(key, loading);
  }
  return collections.get(key);
}

function jsonResponse(status, cacheControl, payload) {
  return {
    status,
    headers: { "content-type": JSON_TYPE, "cache-control": cacheControl },
    body: JSON.stringify(payload),
  };
}

function errorResponse(status, message) {
  return jsonResponse(status, ERROR_CACHE_CONTROL, { message });
}

function requestedIcons(url) {
  const names = (url.searchParams.get("icons") ?? "")
    .split(ICON_NAME_SEPARATOR)
    .filter(Boolean);
  if (!names.length || !names.every((name) => ICON_NAME.test(name)))
    return undefined;
  return [...new Set(names)];
}

/** Whether the generated server answers `pathname` with `iconResponse`. */
export function isIconRequest(pathname) {
  return pathname.startsWith(ICON_API_PATH);
}

/**
 * Answer an Iconify API icon query from the collections installed under
 * `root`: the subset of `@iconify-json/<prefix>` (or `@iconify/json`) holding
 * the requested icons, and a `not_found` list for the others, as
 * `api.iconify.design` does. Returns the status, headers and body to send.
 */
export async function iconResponse(root, method, url) {
  if (!READ_METHODS.has(method)) {
    const response = errorResponse(405, "Method not allowed");
    response.headers.allow = [...READ_METHODS].join(", ");
    return response;
  }
  const prefix = url.pathname
    .slice(ICON_API_PATH.length)
    .match(COLLECTION_FILE)?.[1];
  const names = requestedIcons(url);
  if (!prefix || !ICON_NAME.test(prefix) || !names)
    return errorResponse(400, "Invalid icon request");
  const data = await collection(root, prefix);
  if (!data) return errorResponse(404, "Unknown icon collection");
  return jsonResponse(200, ICON_CACHE_CONTROL, getIcons(data, names, true));
}

/**
 * Serve an Iconify API query from the collections installed in the workspace,
 * the same way under `ajs dms dev` and `ajs dms start`: both run this server.
 */
export async function handleIcons(request, response) {
  const url = new URL(request.url, "http://frontend.local");
  const { status, headers, body } = await iconResponse(
    WORKSPACE_ROOT,
    request.method,
    url,
  );
  return writeContent(request, response, status, headers, body);
}
