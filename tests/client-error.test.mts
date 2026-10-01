import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { maxHeaderSize } from "node:http";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";

const SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/vue/server.mjs",
);
const READY = /✓ Server ready on http:\/\/127\.0\.0\.1:(\d+)/;
const HINT = /headers exceed the \d+-byte limit[^]*clear this site's cookies/;
// Cookies a browser piled up on localhost, past what Node parses.
const OVERSIZED_REQUEST =
  "GET / HTTP/1.1\r\nHost: localhost\r\n" +
  `Cookie: stale=${"x".repeat(maxHeaderSize)}\r\n\r\n`;

async function startServer(context: TestContext) {
  const server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DMS_DEV: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  context.after(() => server.kill());
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
  return { port, output };
}

/** Send `request` raw, and resolve with everything the server answers. */
function exchange(port: number, request: string): Promise<string> {
  return new Promise((settle, fail) => {
    let answer = "";
    const socket = connect(port, "127.0.0.1", () => socket.write(request));
    socket.on("data", (chunk) => (answer += chunk));
    socket.on("close", () => settle(answer));
    // The server may close before reading the whole request.
    socket.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNRESET" ? settle(answer) : fail(error),
    );
  });
}

describe("requests Node rejects before the frontend handler", () => {
  it(
    "answers oversized headers with 431 and explains it once",
    { timeout: 15_000 },
    async (context) => {
      const { port, output } = await startServer(context);
      for (let attempt = 0; attempt < 2; attempt++) {
        const answer = await exchange(port, OVERSIZED_REQUEST);
        assert.match(
          answer,
          /^HTTP\/1\.1 431 Request Header Fields Too Large\r\n/,
        );
      }
      assert.match(output.stderr, HINT);
      assert.equal(
        output.stderr.match(new RegExp(HINT, "g"))?.length,
        1,
        "a retried page logs the hint once",
      );
    },
  );

  it(
    "answers any other malformed request with 400",
    { timeout: 15_000 },
    async (context) => {
      const { port, output } = await startServer(context);
      const answer = await exchange(port, "NOT A REQUEST\r\n\r\n");
      assert.match(answer, /^HTTP\/1\.1 400 Bad Request\r\n/);
      assert.doesNotMatch(output.stderr, HINT);
    },
  );
});
