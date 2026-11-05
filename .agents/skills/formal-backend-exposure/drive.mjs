import { existsSync } from "node:fs";
import { createServer, IncomingMessage, request, ServerResponse } from "node:http";
import { Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleRequestSafely } from "../../../templates/vue/server.mjs";
import { SESSION_COOKIE, scopedCookieName, writeSession } from "../../../templates/vue/server/auth/session.mjs";
import { MARK } from "./inputs.mjs";

/** @typedef {import("./inputs.mjs").Case} Case */
/** @typedef {import("./inputs.mjs").Visit} Visit */
/** @typedef {{ method: string, url: string, headers: import("node:http").IncomingHttpHeaders }} BackendRequest */
/**
 * What one visit did: the status the visitor got, every request the backend
 * received meanwhile, and the Host, Origin and client address it was sent
 * with.
 *
 * @typedef {{ status: number, received: BackendRequest[], host: string, origin: string | undefined, clientAddress: string }} Observation
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const TEMPLATE = path.join(ROOT, "templates/vue");
const SESSION_SECRET = "formal-backend-exposure-session-secret-0123456789";
const OTHER_HOST = "evil.example";
const VISIT_TIMEOUT_MS = 10_000;
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ENVIRONMENT = ["DMS_DEV", "DMS_TRUSTED_PROXY_HOPS", "DMS_CLIENT_IP_HEADER", "DMS_COUNTRY_HEADER", "DMS_BACKEND_PROXIES", "DMS_PUBLIC_ENDPOINTS"];
/** Files that would add declarations the harness does not generate. */
const DECLARING_FILES = ["generated-public-endpoints.json", "dist/server-modules"];

/** The access token of the visitor's session. */
const ACCESS_TOKEN = "session-access-token";

/** The `Authorization` the backend gets for the visitor's session. */
export const SESSION_AUTHORIZATION = `Bearer ${ACCESS_TOKEN}`;

/**
 * @param {string | import("node:net").AddressInfo | null} address
 * @returns {address is import("node:net").AddressInfo} Whether it is a TCP address
 */
function isPortAddress(address) {
  return address !== null && typeof address !== "string";
}

/**
 * @param {import("node:http").Server} server
 * @returns {Promise<number>}
 */
async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (!isPortAddress(address)) throw new Error("the server is not listening on a port");
  return address.port;
}

/**
 * The cookie header for a visit: a session sealed by the server's own code
 * for this deployment, or one that does not open, or another instance's,
 * next to a cookie of the visitor's choosing.
 *
 * @param {import("./inputs.mjs").SessionKind} kind
 */
function cookieFor(kind) {
  const response = new ServerResponse(new IncomingMessage(new Socket()));
  writeSession(response, { accessToken: ACCESS_TOKEN, refreshToken: "session-refresh-token", accountId: "account-a", persistent: false, user: { id: "account-a" } });
  const sealed = String([response.getHeader("set-cookie") ?? ""].flat()[0]).split(";")[0] ?? "";
  const value = sealed.slice(sealed.indexOf("=") + 1);
  const visitor = `zqother=${MARK}-cookie`;
  if (kind === "valid") return `${visitor}; ${scopedCookieName(SESSION_COOKIE)}=${value}`;
  if (kind === "forged") return `${visitor}; ${scopedCookieName(SESSION_COOKIE)}=${MARK}-forged`;
  if (kind === "foreign") return `${visitor}; ${SESSION_COOKIE}_000000000000=${value}`;
  return visitor;
}

/**
 * @param {Visit} visit
 * @param {string} host
 */
function originFor(visit, host) {
  if (visit.origin === "own") return `http://${host}`;
  if (visit.origin === "https-own") return `https://${host}`;
  if (visit.origin === "other") return `http://${OTHER_HOST}:8080`;
  if (visit.origin === "null") return "null";
  return undefined;
}

/** @param {string} name */
function visitorValue(name) {
  if (name === "referer") return `http://${MARK}.example/referer`;
  if (name === "authorization") return `Bearer ${MARK}-authorization`;
  return `${MARK}-${name}`;
}

/**
 * Starts a backend that records what it receives and answers `{}`, and the
 * renderer's real frontend server (`templates/vue/server.mjs`, production
 * mode, no built server modules) in front of it. The server reads its
 * environment per request, so it is set here, after the imports.
 *
 * @returns {Promise<{ visit: (current: Case) => Promise<Observation>, close: () => void }>}
 */
export async function startServers() {
  const stray = DECLARING_FILES.filter((file) => existsSync(path.join(TEMPLATE, file)));
  if (stray.length) throw new Error(`${stray.map((file) => `templates/vue/${file}`).join(", ")} would add declarations the harness does not generate: remove it`);
  /** @type {BackendRequest[]} */
  let received = [];
  const backend = createServer((incoming, answer) => {
    received.push({ method: incoming.method ?? "", url: incoming.url ?? "", headers: incoming.headers });
    incoming.resume();
    incoming.on("end", () => {
      answer.writeHead(200, { "content-type": "application/json" });
      answer.end("{}");
    });
  });
  for (const name of ENVIRONMENT) delete process.env[name];
  process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
  process.env.DMS_SESSION_SECRET = SESSION_SECRET;
  const frontend = createServer(handleRequestSafely);
  const port = await listen(frontend);

  /** @param {Case} current */
  const visit = async ({ deployment, visit: sent }) => {
    process.env.DMS_BACKEND_PROXIES = JSON.stringify(deployment.proxies);
    process.env.DMS_PUBLIC_ENDPOINTS = JSON.stringify(deployment.endpoints);
    received = [];
    const host = sent.host === "own" ? `127.0.0.1:${port}` : OTHER_HOST;
    const origin = originFor(sent, host);
    /** @type {Record<string, string>} */
    const headers = { host, cookie: cookieFor(sent.session) };
    if (origin) headers.origin = origin;
    for (const name of sent.headers) headers[name] = visitorValue(name);
    const body = BODY_METHODS.has(sent.method) ? "{}" : undefined;
    if (body) headers["content-length"] = String(body.length);
    const { status, clientAddress } = await send({ port, method: sent.method, path: sent.target, headers, body });
    return { status, received, host, origin, clientAddress };
  };
  return {
    visit,
    close: () => {
      frontend.closeAllConnections();
      frontend.close();
      backend.closeAllConnections();
      backend.close();
    },
  };
}

/**
 * Sends one raw request, the target as written, and drains the answer.
 *
 * @param {{ port: number, method: string, path: string, headers: Record<string, string>, body: string | undefined }} options
 * @returns {Promise<{ status: number, clientAddress: string }>}
 */
function send({ port, method, path: target, headers, body }) {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: "127.0.0.1", port, method, path: target, headers, agent: false, setHost: false }, (answer) => {
      const clientAddress = answer.socket.localAddress ?? "";
      answer.resume();
      answer.on("end", () => resolve({ status: answer.statusCode ?? 0, clientAddress }));
    });
    outgoing.setTimeout(VISIT_TIMEOUT_MS, () => outgoing.destroy(new Error(`${method} ${target} got no answer in ${VISIT_TIMEOUT_MS} ms`)));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}
