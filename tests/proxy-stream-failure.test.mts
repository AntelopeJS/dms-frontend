import assert from "node:assert/strict";
import {
  createServer,
  get,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, it } from "node:test";
import "./fixtures/dms-backend-proxies.mts";

interface ServerTemplate {
  handleRequestSafely: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>;
}

interface ProxyCompression {
  relayAnswer: (
    request: IncomingMessage,
    response: ServerResponse,
    upstream: { status: number; headers: Headers; body: ReadableStream },
  ) => Promise<void>;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * How long the backend's event stream lives before it breaks, like a backend
 * restarting or undici's body timeout on a stream that went quiet.
 */
const STREAM_LIFETIME_MS = 50;
/** Long enough for a body nobody listens to to have failed by then. */
const SETTLE_MS = STREAM_LIFETIME_MS * 4;
const EVENT_STREAM = "text/event-stream";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** Opens `path` and leaves before the server answered. */
function leaveEarly(port: number, path: string) {
  const outgoing = get({ host: "127.0.0.1", port, path, agent: false });
  outgoing.on("error", () => {});
  outgoing.on("socket", (socket) =>
    socket.on("connect", () => setImmediate(() => outgoing.destroy())),
  );
}

/** Calls `handler` once the client of the request has left. */
function afterTheClientLeft(handler: Handler): Handler {
  return (request, response) =>
    response.once("close", () => handler(request, response));
}

/** A body that sends one event, then fails as a fetch body does. */
function failingEventStream(onCancel: () => void): ReadableStream {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      setTimeout(
        () => controller.error(new TypeError("terminated")),
        STREAM_LIFETIME_MS,
      );
    },
    cancel: onCancel,
  });
}

describe("a backend stream that fails", () => {
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backendRequests: string[] = [];
  const backend = createServer((request, response) => {
    backendRequests.push(request.url ?? "");
    response.writeHead(200, { "content-type": EVENT_STREAM });
    response.write("retry: 500\n: connected\n\n");
    setTimeout(() => response.socket?.destroy(), STREAM_LIFETIME_MS);
  });
  let handler: Handler = () => {};
  const frontend = createServer((request, response) =>
    handler(request, response),
  );
  let frontendPort = 0;
  let runtime: ServerTemplate;
  let compression: ProxyCompression;

  before(async () => {
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    runtime = (await import("../templates/vue/server.mjs")) as ServerTemplate;
    compression =
      (await import("../templates/vue/server/proxy-compression.mjs")) as ProxyCompression;
    frontendPort = await listen(frontend);
  });

  after(() => {
    process.env.DMS_API_BASE_URL = previousBackend;
    frontend.close();
    frontend.closeAllConnections();
    backend.close();
    backend.closeAllConnections();
  });

  it("ends the response, not the server, when it breaks mid-stream", async () => {
    handler = (request, response) =>
      void runtime.handleRequestSafely(request, response);
    const outcome = await new Promise<{ status?: number; body: string }>(
      (resolve) => {
        const outgoing = get(
          { host: "127.0.0.1", port: frontendPort, path: "/dms/dev" },
          (incoming) => {
            let body = "";
            incoming.setEncoding("utf8");
            incoming.on("data", (chunk) => (body += chunk));
            incoming.on("error", () => {});
            incoming.on("close", () =>
              resolve({ status: incoming.statusCode, body }),
            );
          },
        );
        outgoing.on("error", () => {});
      },
    );
    assert.equal(outcome.status, 200);
    assert.match(outcome.body, /: connected/);
  });

  it("opens no backend stream for a client that left during routing", async () => {
    const before = backendRequests.length;
    const handled = new Promise<void>((resolve) => {
      handler = afterTheClientLeft(
        (request, response) =>
          void runtime.handleRequestSafely(request, response).then(resolve),
      );
    });
    leaveEarly(frontendPort, "/dms/dev");
    await handled;
    await delay(SETTLE_MS);
    assert.equal(backendRequests.length, before);
  });

  it("cancels a body it can no longer relay instead of leaving it unread", async () => {
    let cancelled = false;
    const relayed = new Promise<void>((resolve, reject) => {
      handler = afterTheClientLeft((request, response) =>
        compression
          .relayAnswer(request, response, {
            status: 200,
            headers: new Headers({ "content-type": EVENT_STREAM }),
            body: failingEventStream(() => (cancelled = true)),
          })
          .then(resolve, reject),
      );
    });
    leaveEarly(frontendPort, "/dms/dev");
    await relayed;
    await delay(SETTLE_MS);
    assert.equal(cancelled, true);
  });
});
