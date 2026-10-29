import "./dms-backend-proxies.mts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface ServerTemplate {
  assetVersion: () => string;
  createInertiaPage: (url: string, props: unknown) => Record<string, unknown>;
  inertiaAppHtml: (page: unknown) => string;
  inertiaHeaders: () => Record<string, string>;
  htmlHeaders: () => Record<string, string>;
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
  redirectFrontendVisit: (
    request: unknown,
    response: unknown,
    location: string,
  ) => void;
  renderHtml: (
    page: unknown,
    requestUrl: string,
  ) => Promise<{ html: string; status: number }>;
}

export const server = import(
  join(process.cwd(), "templates", "vue", "server.mjs")
) as Promise<ServerTemplate>;

export interface SessionTemplate {
  writeSession: (response: unknown, session: Record<string, unknown>) => void;
}

export const sessions = import(
  join(process.cwd(), "templates", "vue", "server", "auth", "session.mjs")
) as Promise<SessionTemplate>;

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
  session: Record<string, unknown>,
): Promise<string> {
  process.env.DMS_SESSION_SECRET ??=
    "test-secret-with-at-least-thirty-two-characters";
  const sessionRuntime = await sessions;
  const headers = new Map<string, string | string[]>();
  sessionRuntime.writeSession(
    {
      getHeader: (name: string) => headers.get(name),
      setHeader: (name: string, value: string | string[]) =>
        headers.set(name, value),
    },
    session,
  );
  return [headers.get("set-cookie") ?? []]
    .flat()
    .map((value) => value.split(";")[0])
    .join("; ");
}
