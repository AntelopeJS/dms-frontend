import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";

// A socket the proxy kept open would otherwise hang the test until Node's
// keep-alive idle timeout.
const CLOSE_TIMEOUT_MS = 2_000;

interface ServerTemplate {
  handleRequestSafely: (request: unknown, response: unknown) => Promise<void>;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}

/** Everything the server sends before it closes the socket. */
function requestUntilClosed(port: number, path: string) {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: frontend\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.setTimeout(CLOSE_TIMEOUT_MS, () =>
      socket.destroy(new Error("the proxy kept the connection open")),
    );
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("error", reject);
    socket.on("end", () => resolve(data));
  });
}

describe("the proxy and the client's connection", () => {
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backend = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "application/json",
      connection: "keep-alive, x-backend-hop",
      "keep-alive": "timeout=5",
      "x-backend-hop": "1",
    });
    response.end('{"from":"backend"}');
  });
  let frontend: Server | undefined;
  let frontendPort = 0;

  before(async () => {
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

  it("closes the socket when the client asks for Connection: close", async () => {
    const response = await requestUntilClosed(frontendPort, "/api/items");
    const [head = "", body] = response.split("\r\n\r\n");
    assert.match(head, /^HTTP\/1\.1 200/);
    assert.match(head, /^connection: close$/im);
    assert.doesNotMatch(head, /^keep-alive:/im);
    assert.doesNotMatch(head, /^x-backend-hop:/im);
    assert.match(body ?? "", /"from":"backend"/);
  });
});
