/**
 * A backend of the journey's own, for the commands that call one: it serves the frontend manifest,
 * takes the ready report, and records every request.
 */
import { createServer } from "node:http";
import { listeningPort } from "./cli-run.mjs";

/**
 * @typedef {object} SeenRequest
 * @property {string} method
 * @property {string} url
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {string} body
 * @property {number} at Milliseconds since the backend started
 */

/**
 * @typedef {object} CliBackend
 * @property {string} url
 * @property {number} port
 * @property {SeenRequest[]} requests Every request, in order of arrival
 * @property {(path: string) => SeenRequest[]} to Requests whose path (without query) is `path`
 * @property {{ manifest: { status: number, body: unknown }, ready: (index: number) => number }} behaviour What it answers; changeable while it runs
 * @property {() => Promise<void>} close
 */

/**
 * @param {{ modules?: unknown[], version?: number, port?: number }} [options] The manifest it serves
 * @returns {Promise<CliBackend>} The listening backend
 */
export async function startCliBackend(options = {}) {
  const startedAt = Date.now();
  /** @type {SeenRequest[]} */
  const requests = [];
  /** @type {Set<import("node:net").Socket>} */
  const sockets = new Set();
  const behaviour = {
    manifest: { status: 200, body: { version: options.version ?? 2, modules: options.modules ?? [] } },
    ready: () => 204,
  };
  const server = createServer((request, response) => {
    /** @type {Buffer[]} */
    const parts = [];
    request.on("data", (part) => {
      parts.push(Buffer.from(String(part)));
    });
    request.on("end", () => {
      const path = (request.url ?? "").split("?")[0];
      const seen = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(parts).toString("utf8"),
        at: Date.now() - startedAt,
      };
      requests.push(seen);
      if (path === "/dms/frontend/ready") {
        const index = requests.filter((entry) => entry.url.split("?")[0] === path).length - 1;
        response.writeHead(behaviour.ready(index));
        response.end();
        return;
      }
      if (path === "/dms/frontend") {
        response.writeHead(behaviour.manifest.status, { "content-type": "application/json" });
        response.end(JSON.stringify(behaviour.manifest.body));
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", () => resolve(undefined)));
  const port = listeningPort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    to: (path) => requests.filter((seen) => seen.url.split("?")[0] === path),
    behaviour,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Runs `body` with a backend and always closes it.
 *
 * @template T
 * @param {Parameters<typeof startCliBackend>[0]} options The manifest it serves
 * @param {(backend: CliBackend) => Promise<T>} body What to do with it
 * @returns {Promise<T>} What `body` returns
 */
export async function withCliBackend(options, body) {
  const backend = await startCliBackend(options);
  try {
    return await body(backend);
  } finally {
    await backend.close();
  }
}
