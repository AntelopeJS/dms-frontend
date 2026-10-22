import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { DMS_BACKEND_PROXIES } from "./fixtures/dms-backend-proxies.mts";

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

interface BackendRequest {
  method?: string;
  url?: string;
  headers: IncomingHttpHeaders;
  bytes: number;
  completed: boolean;
}

const MEBIBYTE = 1024 * 1024;
// Above the antelope API module's default request body limit (1 MiB): the
// proxy must not stand in for it.
const TRANSFER_BYTES = 3 * MEBIBYTE;
const MAX_BODY_BYTES = 4 * MEBIBYTE;
const TOO_LARGE_BYTES = 5 * MEBIBYTE;
const CHUNK_BYTES = 64 * 1024;
const TOKEN = "query-token-never-logged";
const RELATIVE_LOCATION = "/media/asset-id/photo%20one.png?v=2";
const UNREACHABLE_STORAGE_URL = `http://127.0.0.1:1/file-storage/files/key?token=${TOKEN}`;
const STORAGE_PROXIES = JSON.stringify([
  ...JSON.parse(DMS_BACKEND_PROXIES),
  {
    path: "/file-storage/upload/**",
    auth: "none",
    maxBodyBytes: MAX_BODY_BYTES,
  },
  { path: "/file-storage/files/**", auth: "none" },
]);

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** A promise and the function that settles it. */
function signal() {
  let settle = () => {};
  const promise = new Promise<void>((resolve) => (settle = resolve));
  return { promise, settle };
}

/**
 * A body that sends its first chunk, then waits for `release` before the
 * rest: a proxy that buffers the whole body before passing it on never
 * releases it, and the transfer hangs.
 */
function gatedBody(totalBytes: number, release: Promise<void>) {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= totalBytes) return controller.close();
      if (sent > 0) await release;
      const size = Math.min(CHUNK_BYTES, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(1));
    },
  });
}

describe("the proxy streams large file-storage transfers", () => {
  const previous = {
    backend: process.env.DMS_API_BASE_URL,
    proxies: process.env.DMS_BACKEND_PROXIES,
  };
  const logged: string[] = [];
  const consoleMethods = ["log", "info", "warn", "error"] as const;
  const originals = consoleMethods.map((name) => console[name]);
  let requests: BackendRequest[] = [];
  let firstUploadChunk = signal();
  let firstDownloadChunk = signal();
  const backend = createServer((request, response) => {
    const seen: BackendRequest = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      bytes: 0,
      completed: false,
    };
    requests.push(seen);
    if (request.url?.startsWith("/api/relative-redirect")) {
      // Media's canonical link, relative, with a cookie the backend sets.
      response.writeHead(302, {
        location: RELATIVE_LOCATION,
        "set-cookie": ["first=1; Path=/; HttpOnly", "second=2; Path=/"],
      });
      return response.end();
    }
    if (request.url?.startsWith("/api/redirect")) {
      // Media's link to a file: the storage's signed URL, on an origin the
      // frontend server cannot reach.
      response.writeHead(302, { location: UNREACHABLE_STORAGE_URL });
      return response.end();
    }
    if (request.method === "GET") {
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-length": String(TRANSFER_BYTES),
      });
      response.write(new Uint8Array(CHUNK_BYTES).fill(2));
      void firstDownloadChunk.promise.then(() =>
        response.end(new Uint8Array(TRANSFER_BYTES - CHUNK_BYTES).fill(2)),
      );
      return;
    }
    request.on("data", (chunk: Buffer) => {
      seen.bytes += chunk.byteLength;
      firstUploadChunk.settle();
    });
    request.on("end", () => {
      seen.completed = true;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ received: seen.bytes }));
    });
  });
  let frontendUrl = "";
  let frontend: Server | undefined;

  before(async () => {
    consoleMethods.forEach((name) => {
      console[name] = (...values: unknown[]) => {
        logged.push(values.map((value) => String(value)).join(" "));
      };
    });
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    process.env.DMS_BACKEND_PROXIES = STORAGE_PROXIES;
    const runtime =
      (await import("../templates/vue/server.mjs")) as ServerTemplate;
    frontend = createServer(runtime.handleRequestSafely);
    frontendUrl = `http://127.0.0.1:${await listen(frontend)}`;
  });

  afterEach(() => {
    requests = [];
    firstUploadChunk = signal();
    firstDownloadChunk = signal();
  });

  after(() => {
    consoleMethods.forEach((name, index) => (console[name] = originals[index]));
    process.env.DMS_API_BASE_URL = previous.backend;
    process.env.DMS_BACKEND_PROXIES = previous.proxies;
    frontend?.close();
    backend.close();
    assert.ok(
      logged.every((line) => !line.includes(TOKEN)),
      `the token reached the logs:\n${logged.join("\n")}`,
    );
  });

  it("streams an upload to the backend without the cookie or the session", async () => {
    const response = await fetch(
      `${frontendUrl}/file-storage/upload/key?token=${TOKEN}`,
      {
        method: "PUT",
        headers: {
          cookie: "dms_session=sealed; other=1",
          authorization: "Bearer member-token",
          "content-type": "application/octet-stream",
        },
        body: gatedBody(TRANSFER_BYTES, firstUploadChunk.promise),
        duplex: "half",
      } as RequestInit,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { received: TRANSFER_BYTES });
    const [seen] = requests;
    assert.equal(seen?.url, `/file-storage/upload/key?token=${TOKEN}`);
    assert.equal(seen?.headers.cookie, undefined);
    assert.equal(seen?.headers.authorization, undefined);
  });

  it("streams a download to the client as the backend writes it", async () => {
    const response = await fetch(
      `${frontendUrl}/file-storage/files/folder%2Fphoto.png?token=${TOKEN}`,
      { headers: { cookie: "dms_session=sealed" } },
    );
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("content-length"),
      String(TRANSFER_BYTES),
    );
    const reader = response.body!.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      firstDownloadChunk.settle();
    }
    assert.equal(received, TRANSFER_BYTES);
    const [seen] = requests;
    assert.equal(
      seen?.url,
      `/file-storage/files/folder%2Fphoto.png?token=${TOKEN}`,
    );
    assert.equal(seen?.headers.cookie, undefined);
  });

  it("answers 413 to a declared length over the limit, before reaching the backend", async () => {
    const response = await fetch(
      `${frontendUrl}/file-storage/upload/key?token=${TOKEN}`,
      { method: "PUT", body: new Uint8Array(TOO_LARGE_BYTES) },
    );
    assert.equal(response.status, 413);
    await response.arrayBuffer();
    assert.deepEqual(requests, []);
  });

  it("cuts a chunked body off with 413 once it goes over the limit", async () => {
    const response = await fetch(
      `${frontendUrl}/file-storage/upload/key?token=${TOKEN}`,
      {
        method: "PUT",
        body: gatedBody(TOO_LARGE_BYTES, Promise.resolve()),
        duplex: "half",
      } as RequestInit,
    );
    assert.equal(response.status, 413);
    await response.arrayBuffer();
    const [seen] = requests;
    assert.equal(seen?.completed, false);
    assert.ok((seen?.bytes ?? 0) <= MAX_BODY_BYTES);
  });

  it("hands a backend redirect to the client instead of following it", async () => {
    const response = await fetch(`${frontendUrl}/api/redirect`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), UNREACHABLE_STORAGE_URL);
    await response.arrayBuffer();
  });

  it("relays a relative Location and every Set-Cookie unchanged", async () => {
    const response = await fetch(`${frontendUrl}/api/relative-redirect`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), RELATIVE_LOCATION);
    assert.deepEqual(response.headers.getSetCookie(), [
      "first=1; Path=/; HttpOnly",
      "second=2; Path=/",
    ]);
    await response.arrayBuffer();
  });

  it("keeps the token out of the logs when the backend is down", async () => {
    const backendUrl = process.env.DMS_API_BASE_URL;
    process.env.DMS_API_BASE_URL = "http://127.0.0.1:1";
    try {
      const response = await fetch(
        `${frontendUrl}/file-storage/files/photo.png?token=${TOKEN}`,
      );
      assert.equal(response.status, 502);
      await response.arrayBuffer();
    } finally {
      process.env.DMS_API_BASE_URL = backendUrl;
    }
    assert.ok(
      logged.some((line) => line.includes("DMS backend request failed")),
    );
  });
});
