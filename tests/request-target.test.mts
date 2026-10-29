import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  backendUrl,
  isOriginForm,
} from "../templates/vue/server/request-target.mjs";
import "./fixtures/dms-backend-proxies.mts";
import { addressOf } from "./helpers/net";

const BACKEND = "http://127.0.0.1:8080";
/** A request the server dropped would otherwise wait forever. */
const REQUEST_TIMEOUT_MS = 10_000;

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = addressOf(server);
  return address.port;
}

const HEAD_END = "\r\n\r\n";
const LAST_CHUNK = "0\r\n\r\n";

/** The head and body of `data` once it holds a whole response. */
function completeResponse(data: string) {
  const headEnd = data.indexOf(HEAD_END);
  if (headEnd < 0) return undefined;
  const head = data.slice(0, headEnd);
  const body = data.slice(headEnd + HEAD_END.length);
  const length = /^content-length:\s*(\d+)\s*$/im.exec(head)?.[1];
  if (length !== undefined)
    return Buffer.byteLength(body) >= Number(length)
      ? { head, body }
      : undefined;
  if (/^transfer-encoding:\s*chunked\s*$/im.test(head))
    return body === LAST_CHUNK || body.endsWith(`\r\n${LAST_CHUNK}`)
      ? { head, body }
      : undefined;
  return undefined;
}

/**
 * Sends `target` verbatim, as `fetch` would normalize it first. Settles once
 * the whole response is read rather than when the server closes the socket,
 * which a kept-alive connection only does after its idle timeout.
 */
function rawRequest(port: number, method: string, target: string) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        `${method} ${target} HTTP/1.1\r\nHost: frontend\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
      socket.destroy(new Error("timeout")),
    );
    let data = "";
    const settle = (response: { head: string; body: string }) => {
      socket.destroy();
      resolve({
        status: Number(response.head.split(" ")[1]),
        body: response.body,
      });
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      data += chunk;
      const response = completeResponse(data);
      if (response) settle(response);
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const [head = "", body = ""] = data.split(HEAD_END);
      settle({ head, body });
    });
  });
}

describe("request targets", () => {
  it("accepts a path, with or without a query", () => {
    for (const target of ["/", "/api/items?page=2", "/a\\b", "/%2f%2fhost"])
      assert.equal(isOriginForm(target), true, target);
  });

  it("refuses a target naming another host", () => {
    for (const target of [
      "//169.254.169.254/latest/meta-data",
      "http://169.254.169.254/latest/meta-data",
      "http://frontend.local/api/items",
      "/\\169.254.169.254/latest/meta-data",
      "\\\\169.254.169.254/x",
      "*",
      "169.254.169.254:80",
      "",
    ])
      assert.equal(isOriginForm(target), false, target);
  });

  it("keeps the backend's origin whatever the path normalizes to", () => {
    assert.equal(
      backendUrl("/api/items?page=2", `${BACKEND}/ignored`).href,
      `${BACKEND}/api/items?page=2`,
    );
    for (const target of ["/x/..//evil/a", "/%2e%2e//evil", "/%2f%2fevil/a"])
      assert.equal(backendUrl(target, BACKEND).origin, BACKEND, target);
    assert.equal(
      backendUrl("/x/..//evil/a", BACKEND).href,
      `${BACKEND}//evil/a`,
    );
  });
});

describe("the proxy with a target naming another host", () => {
  const previousBackend = process.env.DMS_API_BASE_URL;
  const backendUrls: string[] = [];
  const attackerUrls: string[] = [];
  const backend = createServer((request, response) => {
    backendUrls.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"from":"backend"}');
  });
  const attacker = createServer((request, response) => {
    attackerUrls.push(request.url ?? "");
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("metadata");
  });
  let frontend: Server | undefined;
  let frontendPort = 0;
  let attackerHost = "";

  before(async () => {
    process.env.DMS_API_BASE_URL = `http://127.0.0.1:${await listen(backend)}`;
    attackerHost = `127.0.0.1:${await listen(attacker)}`;
    const runtime = await import("../templates/vue/server.mjs");
    frontend = createServer(runtime.handleRequestSafely);
    frontendPort = await listen(frontend);
  });

  after(() => {
    process.env.DMS_API_BASE_URL = previousBackend;
    frontend?.close();
    backend.close();
    attacker.close();
  });

  it("answers 400 and never reaches the other host", async () => {
    for (const [method, target] of [
      ["GET", `//${attackerHost}/latest/meta-data`],
      ["GET", `http://${attackerHost}/latest/meta-data`],
      ["GET", `/\\${attackerHost}/latest/meta-data`],
      ["GET", `//${attackerHost}/api/items`],
      ["POST", `//${attackerHost}/api/items`],
      ["OPTIONS", `//${attackerHost}/dms/page`],
    ]) {
      const response = await rawRequest(frontendPort, method, target);
      assert.equal(response.status, 400, `${method} ${target}`);
    }
    assert.deepEqual(attackerUrls, []);
    assert.deepEqual(backendUrls, []);
  });

  it("proxies an encoded double slash to the backend as a path", async () => {
    const response = await rawRequest(
      frontendPort,
      "GET",
      `/api/%2f%2f${attackerHost}/x`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(attackerUrls, []);
    assert.deepEqual(backendUrls, [`/api/%2f%2f${attackerHost}/x`]);
  });

  it("never proxies a path normalizing out of the backend's prefixes", async () => {
    await rawRequest(
      frontendPort,
      "GET",
      `/api/../x/..//${attackerHost}/api/x`,
    );
    assert.deepEqual(attackerUrls, []);
    assert.ok(
      !backendUrls.includes(`//${attackerHost}/api/x`),
      backendUrls.join(),
    );
  });
});
