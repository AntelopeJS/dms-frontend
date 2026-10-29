import assert from "node:assert/strict";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { after, before, describe, it } from "node:test";
import { brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import "./fixtures/dms-backend-proxies.mts";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

type Route = (request: IncomingMessage, response: ServerResponse) => void;

/** Above the 1 KiB the server compresses from. */
const ROWS = JSON.stringify({
  results: Array.from({ length: 200 }, (_, index) => ({
    _id: String(index),
    label: `Row ${index}`,
  })),
});
const STREAM_PART_TIMEOUT_MS = 2_000;
const SYNC_FLUSH_MARKER = Buffer.from([0, 0, 255, 255]);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

interface RawAnswer {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

describe("the proxy compresses what the backend did not", () => {
  const previousBackend = process.env.DMS_API_BASE_URL;
  const routes = new Map<string, Route>();
  const backend = createServer((request, response) => {
    const route = routes.get(new URL(request.url ?? "/", "http://b").pathname);
    if (route) return route(request, response);
    response.writeHead(404);
    response.end();
  });
  let frontend: Server | undefined;
  let frontendPort = 0;

  /** The answer as the client receives it, its body still encoded. */
  function get(
    path: string,
    headers: OutgoingHttpHeaders = {},
    method = "GET",
  ): Promise<RawAnswer> {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: "127.0.0.1",
          port: frontendPort,
          path,
          method,
          headers,
          agent: false,
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () =>
            resolve({
              status: incoming.statusCode ?? 0,
              headers: incoming.headers,
              body: Buffer.concat(chunks),
            }),
          );
          incoming.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  }

  before(async () => {
    routes.set("/api/rows", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        vary: "Origin",
        etag: '"rows-1"',
      });
      response.end(ROWS);
    });
    routes.set("/api/small", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": "2",
      });
      response.end("{}");
    });
    routes.set("/api/negotiated", (request, response) => {
      const gzipped = /gzip/.test(request.headers["accept-encoding"] ?? "");
      const body = gzipped ? gzipSync(ROWS) : Buffer.from(ROWS);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length),
        ...(gzipped && { "content-encoding": "gzip" }),
      });
      response.end(body);
    });
    routes.set("/api/no-transform", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-transform",
      });
      response.end(ROWS);
    });
    routes.set("/api/image", (_request, response) => {
      response.writeHead(200, { "content-type": "image/png" });
      response.end(Buffer.alloc(4096));
    });
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    const runtime =
      (await import("../templates/vue/server.mjs")) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    frontendPort = await listen(frontend);
  });

  after(() => {
    process.env.DMS_API_BASE_URL = previousBackend;
    frontend?.close();
    backend.close();
  });

  it("sends a JSON answer in Brotli to a client that accepts it", async () => {
    const answer = await get("/api/rows", { "accept-encoding": "gzip, br" });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-encoding"], "br");
    assert.equal(answer.headers["content-length"], undefined);
    assert.equal(answer.headers.vary, "Origin, Accept-Encoding");
    assert.equal(answer.headers.etag, 'W/"rows-1"');
    assert.ok(answer.body.length < ROWS.length / 2);
    assert.equal(brotliDecompressSync(answer.body).toString(), ROWS);
  });

  it("falls back to gzip, and to the plain answer", async () => {
    const gzipped = await get("/api/rows", { "accept-encoding": "gzip" });
    assert.equal(gzipped.headers["content-encoding"], "gzip");
    assert.equal(gunzipSync(gzipped.body).toString(), ROWS);
    const plain = await get("/api/rows", { "accept-encoding": "identity" });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.headers.vary, "Origin, Accept-Encoding");
    assert.equal(plain.headers.etag, '"rows-1"');
    assert.equal(plain.body.toString(), ROWS);
  });

  it("relays as it came what compressing would not help or would break", async () => {
    const small = await get("/api/small", { "accept-encoding": "br" });
    assert.equal(small.headers["content-encoding"], undefined);
    assert.equal(small.headers["content-length"], "2");
    assert.equal(small.body.toString(), "{}");

    const kept = await get("/api/no-transform", { "accept-encoding": "br" });
    assert.equal(kept.headers["content-encoding"], undefined);
    assert.equal(kept.body.toString(), ROWS);

    const image = await get("/api/image", { "accept-encoding": "br" });
    assert.equal(image.headers["content-encoding"], undefined);
    assert.equal(image.body.length, 4096);

    const head = await get("/api/rows", { "accept-encoding": "br" }, "HEAD");
    assert.equal(head.headers["content-encoding"], undefined);
    assert.equal(head.body.length, 0);
  });

  it("negotiates tokens and qualities rather than substrings", async () => {
    for (const [accepted, encoding] of [
      ["br;q=0, gzip;q=1", "gzip"],
      ["BR;q=0.5, GZIP;q=0.9", "gzip"],
      ["notbr, notgzip", undefined],
      ["*;q=1, br;q=0", "gzip"],
      ["*;q=0, gzip;q=0.8", "gzip"],
      ["identity;q=1, br;q=0.5", undefined],
      ["identity;q=0, br;q=1", "br"],
      ["br;q=0, gzip;q=0", undefined],
      [" br ; q=0, gzip ; q=1", "gzip"],
      ["br;q=bogus, gzip;q=0.8", "gzip"],
    ] as const) {
      const answer = await get("/api/rows", { "accept-encoding": accepted });
      assert.equal(answer.headers["content-encoding"], encoding, accepted);
      assert.equal(answer.headers.vary, "Origin, Accept-Encoding");
    }
  });

  it("repairs headers when fetch decodes a backend ignoring identity", async () => {
    routes.set("/api/forced-gzip", (request, response) => {
      assert.equal(request.headers["accept-encoding"], "identity");
      const body = gzipSync(ROWS);
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": String(body.length),
        etag: '"encoded"',
      });
      response.end(body);
    });
    for (const accepted of ["identity", "br", "gzip"]) {
      const answer = await get("/api/forced-gzip", {
        "accept-encoding": accepted,
      });
      assert.equal(answer.headers["content-length"], undefined);
      assert.equal(
        answer.headers["content-encoding"],
        accepted === "identity" ? undefined : accepted,
      );
      assert.equal(answer.headers.etag, 'W/"encoded"');
      const body =
        accepted === "br"
          ? brotliDecompressSync(answer.body)
          : accepted === "gzip"
            ? gunzipSync(answer.body)
            : answer.body;
      assert.equal(body.toString(), ROWS);
    }
  });

  it("preserves opaque encodings, HEAD metadata and plain ranges", async () => {
    routes.set("/api/opaque", (_request, response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "custom",
        "content-length": String(ROWS.length),
      });
      response.end(ROWS);
    });
    const opaque = await get("/api/opaque", { "accept-encoding": "br" });
    assert.equal(opaque.headers["content-encoding"], "custom");
    assert.equal(opaque.headers["content-length"], String(ROWS.length));
    assert.equal(opaque.body.toString(), ROWS);
    const head = await get(
      "/api/forced-gzip",
      { "accept-encoding": "br" },
      "HEAD",
    );
    assert.equal(head.headers["content-encoding"], "gzip");
    assert.equal(head.headers["content-length"], String(gzipSync(ROWS).length));
    assert.equal(head.body.length, 0);
    routes.set("/api/range", (_request, response) => {
      response.writeHead(206, {
        "content-type": "text/plain",
        "content-range": "bytes 0-2047/4096",
        "content-length": "2048",
      });
      response.end("x".repeat(2048));
    });
    const range = await get("/api/range", { "accept-encoding": "br" });
    assert.equal(range.status, 206);
    assert.equal(range.headers["content-encoding"], undefined);
    assert.equal(range.headers["content-range"], "bytes 0-2047/4096");
    assert.equal(range.body.toString(), "x".repeat(2048));
    routes.set("/api/encoded-range", (_request, response) => {
      response.writeHead(206, {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "content-range": "bytes 0-2047/4096",
      });
      response.end(gzipSync(ROWS));
    });
    const invalidRange = await get("/api/encoded-range");
    assert.equal(invalidRange.status, 502);
    assert.equal(invalidRange.body.length, 0);
    routes.set("/api/not-modified", (_request, response) => {
      response.writeHead(304, {
        "content-encoding": "gzip",
        "content-length": "123",
      });
      response.end();
    });
    const notModified = await get("/api/not-modified");
    assert.equal(notModified.status, 304);
    assert.equal(notModified.headers["content-encoding"], "gzip");
    assert.equal(notModified.headers["content-length"], "123");
  });

  it("passes on each part of a streamed answer as the backend writes it", async () => {
    let finish: (() => void) | undefined;
    routes.set("/api/stream", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write(`${"first part ".repeat(200)}\n`);
      finish = () => response.end("last part\n");
    });
    try {
      const firstPart = await new Promise<Buffer>((resolve, reject) => {
        const outgoing = httpRequest(
          {
            host: "127.0.0.1",
            port: frontendPort,
            path: "/api/stream",
            headers: { "accept-encoding": "gzip" },
            agent: false,
          },
          (incoming) => {
            assert.equal(incoming.headers["content-encoding"], "gzip");
            const chunks: Buffer[] = [];
            const timer = setTimeout(
              () => reject(new Error("the first part was held back")),
              STREAM_PART_TIMEOUT_MS,
            );
            incoming.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              const received = Buffer.concat(chunks);
              if (received.subarray(-4).equals(SYNC_FLUSH_MARKER)) {
                clearTimeout(timer);
                resolve(received);
                finish?.();
              }
            });
            incoming.on("error", reject);
          },
        );
        outgoing.on("error", reject);
        outgoing.end();
      });
      assert.ok(firstPart.length > 0);
    } finally {
      finish?.();
      routes.delete("/api/stream");
    }
  });

  it("relays exactly what the backend sent, whatever it could compress", async () => {
    const answer = await get("/api/negotiated", { "accept-encoding": "br" });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers["content-encoding"], "br");
    assert.equal(brotliDecompressSync(answer.body).toString(), ROWS);
    const plain = await get("/api/negotiated", {
      "accept-encoding": "identity",
    });
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.headers["content-length"], String(ROWS.length));
    assert.equal(plain.body.toString(), ROWS);
  });

  it("leaves an event stream alone", async () => {
    routes.set("/api/events", (_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${"x".repeat(2048)}\n\n`);
    });
    try {
      const events = await get("/api/events", { "accept-encoding": "br" });
      assert.equal(events.headers["content-encoding"], undefined);
      assert.match(events.body.toString(), /^data: x+\n\n$/);
    } finally {
      routes.delete("/api/events");
    }
  });
});
