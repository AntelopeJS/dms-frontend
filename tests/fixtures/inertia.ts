import assert from "node:assert/strict";
import { createServer } from "node:http";
import { responseOf } from "../helpers/http-doubles";
import { addressOf } from "../helpers/net";
import "./dms-backend-proxies.mts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isNumber, isText } from "../helpers/guards";
import {
  isJsonObject,
  isJsonValue,
  jsonAt,
  type JsonObject,
} from "../helpers/json";

export const server = import("../../templates/vue/server.mjs");

export const sessions = import("../../templates/vue/server/auth/session.mjs");

/** A prop the server sent once, and when the browser may stop holding it. */
export interface OnceProp {
  prop: string;
  expiresAt: number | null;
}

/** The page an Inertia visit answers with. */
export interface InertiaPage {
  props: JsonObject;
  onceProps?: Record<string, OnceProp>;
}

function isOnceProp(value: unknown): value is OnceProp {
  if (!isJsonValue(value)) return false;
  const expiresAt = jsonAt(value, "expiresAt");
  return (
    isText(jsonAt(value, "prop")) && (expiresAt === null || isNumber(expiresAt))
  );
}

function isInertiaPage(value: unknown): value is InertiaPage {
  if (!isJsonValue(value)) return false;
  const onceProps = jsonAt(value, "onceProps");
  return (
    isJsonObject(jsonAt(value, "props")) &&
    (onceProps === undefined ||
      (isJsonObject(onceProps) && Object.values(onceProps).every(isOnceProp)))
  );
}

export const SSR_DIRECTORY = join(
  process.cwd(),
  "templates",
  "vue",
  "dist",
  "ssr",
);
export const ACCESS_BLOCKED_CODE = "saas.errors.workspace.access_blocked";
/**
 * Node caches the first renderer import for the whole run: every test that
 * needs one writes this same module.
 */
export const SSR_RENDERER_FIXTURE = `export async function renderDmsPage(page) {
  const serialized = JSON.stringify(page).replaceAll("/", "\\\\/");
  return { body: \`<script data-page="app" type="application/json">\${serialized}</script><div data-server-rendered="true" id="app"></div>\`, head: { headTags: "", htmlAttrs: "", bodyAttrs: "" }, overlays: "" };
}
export function isDmsFrontendPage(path) {
  return path === "/auth/custom";
}
export function accessRedirect(code) {
  return code === "${ACCESS_BLOCKED_CODE}" ? "/workspace-suspended" : undefined;
}\n`;

export async function writeSsrRendererFixture(): Promise<void> {
  await mkdir(SSR_DIRECTORY, { recursive: true });
  await writeFile(join(SSR_DIRECTORY, "ssr-renderer.js"), SSR_RENDERER_FIXTURE);
}

/**
 * The session cookie of `session`, sealed as the module owning sign-in writes
 * it, for the backend `DMS_API_BASE_URL` names.
 */
export async function sessionCookie(
  session: Parameters<
    typeof import("../../templates/vue/server/auth/session.mjs").writeSession
  >[1],
): Promise<string> {
  process.env.DMS_SESSION_SECRET ??=
    "test-secret-with-at-least-thirty-two-characters";
  const { writeSession } = await sessions;
  const response = responseOf();
  writeSession(response, session);
  return [response.getHeaders()["set-cookie"] ?? []]
    .flat()
    .map((value) => value.split(";")[0])
    .join("; ");
}

export const pagePropsModule =
  import("../../templates/vue/server/page-props.mjs");

export const PAGE = {
  route: { fullSlug: "/articles" },
  layout: { id: "layout" },
};
export const SHARED = { siteLayout: { pages: {} }, isOwner: true };
export const FRESH_SHARED = { siteLayout: { pages: {} }, isOwner: false };

export async function frontendWithBackend() {
  const backendCalls: string[] = [];
  const backend = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://backend.local");
    backendCalls.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/dms/sitelayout") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(FRESH_SHARED));
      return;
    }
    if (url.searchParams.get("path") === "/auth/custom") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"message":"error.page_not_found"}');
      return;
    }
    const omitShared = url.searchParams.get("shared") === "false";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(omitShared ? PAGE : { ...PAGE, shared: SHARED }),
    );
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const address = addressOf(backend);
  process.env.DMS_API_BASE_URL = `http://127.0.0.1:${address.port}`;
  const runtime = await server;
  const frontend = createServer(runtime.handleRequestSafely);
  await new Promise<void>((resolve) =>
    frontend.listen(0, "127.0.0.1", resolve),
  );
  const frontendAddress = addressOf(frontend);
  const base = `http://127.0.0.1:${frontendAddress.port}`;
  const visit = async (path: string, headers: Record<string, string> = {}) => {
    backendCalls.length = 0;
    const response = await fetch(`${base}${path}`, {
      headers: { "x-inertia": "true", ...headers },
      redirect: "manual",
    });
    const page: unknown = await response.json();
    assert.ok(isInertiaPage(page), "the visit answered with an Inertia page");
    return { page, backendCalls: [...backendCalls] };
  };
  const close = () => {
    frontend.close();
    backend.close();
  };
  return { visit, close };
}

export function accountCookie(accountId: string): Promise<string> {
  return sessionCookie({
    accessToken: "access",
    accountId,
    activeTenantId: "tenant-1",
    persistent: false,
    user: { id: accountId },
  });
}
