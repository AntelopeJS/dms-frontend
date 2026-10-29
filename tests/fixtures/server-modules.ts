import { mkdirSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server } from "node:http";
import { dirname, join } from "node:path";
import { resolveServerDeclarations } from "../../templates/vue/server/module-routes.mjs";
import { compilePublicEndpoint } from "../../templates/vue/server/public-endpoints.mjs";
import { defineDmsServer } from "../../templates/vue/server-module";
import { addressOf } from "../helpers/net";
export const SESSION_SECRET = "a-test-only-session-secret-of-32-characters";
export const SERVER_ENTRY = "dms.server.ts";

export type Setup = Parameters<typeof defineDmsServer>[0];

export function writeFixture(
  root: string,
  path: string,
  content: string,
): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

export function resolved(
  declarations: { id: string; priority?: number; setup: Setup }[],
  publicEndpoints: unknown[] = [],
) {
  const warnings: string[] = [];
  const { routes } = resolveServerDeclarations(
    declarations,
    (message: string) => warnings.push(message),
    publicEndpoints.map(compilePublicEndpoint),
  );
  return { routes, warnings };
}

export const handler = () => ({ ok: true });

export interface BackendCall {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
}

export async function listen(server: Server): Promise<string> {
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  const address = addressOf(server);
  return `http://127.0.0.1:${address.port}`;
}

export function close(server: Server | undefined): Promise<void> {
  return new Promise((settle) => {
    if (!server?.listening) return settle();
    server.closeAllConnections();
    server.close(() => settle());
  });
}

export const FIXTURE_HANDLERS = `
export function hello(event) {
  return {
    name: event.params.name,
    module: event.module.id,
    options: event.module.options,
    relaySecret: event.module.privateOptions.oauth?.relaySecret,
    origin: event.url.origin,
    query: event.url.searchParams.get("q"),
  };
}

export async function echo(event) {
  const input = await event.readJson();
  event.cookies.writeSealed("fixture_flow", { input }, { maxAge: 60, path: "/auth/fixture" });
  return input;
}

export function stream(event) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const part of ["one ", "two ", "three"]) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
  event.cookies.writeSealed("fixture_seen", { seen: true });
  const headers = new Headers({ "content-type": "text/plain", "cache-control": "max-age=5" });
  headers.append("set-cookie", "plain_a=1; Path=/");
  headers.append("set-cookie", "plain_b=2; Path=/");
  return new Response(body, { status: 201, headers });
}

export async function viaBackend(event) {
  return event.backend("/api/echo", {
    method: "POST",
    body: { from: "module" },
    token: "module-token",
    headers: { "X-Forwarded-For": "1.2.3.4", "X-Fixture": "yes" },
  });
}

export async function raw(event) {
  const response = await fetch(event.backendUrl("//elsewhere.test/api/raw?x=1"));
  return { status: response.status, url: event.backendUrl("/api/raw?x=1").href };
}

export async function refused(event) {
  return event.backend("/api/refuse");
}

export function session(event) {
  return { shadowed: true, signedIn: Boolean(event.session.read()) };
}

export function empty() {
  return null;
}
`;

export const FIXTURE_ENTRY = `
import { defineDmsServer } from "#dms/server";
import * as handlers from "./server/handlers";

export default defineDmsServer((server) => {
  server.registerRoute("GET", "/api/_fixture/hello/:name", handlers.hello);
  server.registerRoute("POST", "/api/_fixture/echo", handlers.echo, { bodyLimit: 64 });
  server.registerRoute("GET", "/api/_fixture/stream", handlers.stream);
  server.registerRoute("POST", "/api/_fixture/backend", handlers.viaBackend);
  server.registerRoute("GET", "/api/_fixture/refused", handlers.refused);
  server.registerRoute("GET", "/api/_fixture/raw", handlers.raw);
  server.registerRoute("GET", "/api/_fixture/empty", handlers.empty);
  server.registerRoute("GET", "/api/_auth/session", handlers.session);
  server.registerRoute("GET", "/assets/taken.js", handlers.empty);
  server.registerBackendProxy("/api/**");
});
`;
