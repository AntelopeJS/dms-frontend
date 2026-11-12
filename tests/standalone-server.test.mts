import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { SERVER_OPTIONS } from "../templates/vue/server/proxy-transfers.mjs";
import { addressOf } from "./helpers/net";

const SERVER = resolve("templates/vue/server.mjs");
const READY = /Server ready on http:\/\/127\.0\.0\.1:(\d+)/;
const REQUEST_TIMEOUT = /requestTimeout=(\d+)/;
/** Prints the request timeout each HTTP server listens with. */
const REPORT_REQUEST_TIMEOUT = `data:text/javascript,${encodeURIComponent(`
import { Server } from "node:http";
const listen = Server.prototype.listen;
Server.prototype.listen = function (...args) {
  process.stderr.write("requestTimeout=" + this.requestTimeout + "\\n");
  return listen.apply(this, args);
};
`)}`;

async function failingBackend(context: TestContext): Promise<string> {
  const backend = createServer((_request, response) => {
    response.writeHead(503, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((settle) => backend.listen(0, "127.0.0.1", settle));
  context.after(() => backend.close());
  return `http://127.0.0.1:${addressOf(backend).port}`;
}

async function startServer(context: TestContext, backendUrl: string) {
  const server = spawn(
    process.execPath,
    ["--import", REPORT_REQUEST_TIMEOUT, SERVER],
    {
      env: {
        ...process.env,
        PORT: "0",
        HOST: "127.0.0.1",
        DMS_DEV: "",
        DMS_API_BASE_URL: backendUrl,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exited = new Promise((settle) => server.once("exit", settle));
  context.after(async () => {
    server.kill();
    await exited;
  });
  const output = { stdout: "", stderr: "" };
  server.stderr.on("data", (chunk: Buffer) => (output.stderr += chunk));
  const port = await new Promise<number>((settle, fail) => {
    server.stdout.on("data", (chunk: Buffer) => {
      output.stdout += chunk;
      const match = output.stdout.match(READY);
      if (match) settle(Number(match[1]));
    });
    server.on("exit", (code) =>
      fail(new Error(`server exited (${code}) before ready: ${output.stderr}`)),
    );
  });
  return { port, output, exited };
}

void describe("the standalone frontend server", () => {
  void it(
    "keeps serving after a backend failure",
    { timeout: 15_000 },
    async (context) => {
      const { port, exited } = await startServer(
        context,
        await failingBackend(context),
      );
      let running = true;
      void exited.then(() => (running = false));
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`http://127.0.0.1:${port}/broken`, {
          headers: { "x-inertia": "true" },
        });
        await response.body?.cancel();
        assert.equal(response.status, 503);
      }
      assert.equal(running, true);
    },
  );

  void it(
    "gives a slow upload the server's own request timeout, not Node's",
    { timeout: 15_000 },
    async (context) => {
      const { output } = await startServer(
        context,
        await failingBackend(context),
      );
      assert.equal(
        Number(output.stderr.match(REQUEST_TIMEOUT)?.[1]),
        SERVER_OPTIONS.requestTimeout,
      );
    },
  );
});
