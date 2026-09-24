import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/vue/server.mjs",
);
const READY = /✓ Server ready on http:\/\/127\.0\.0\.1:(\d+)/;

describe("Frontend server startup", () => {
  it(
    "announces it is ready once it accepts connections",
    { timeout: 15_000 },
    async (context) => {
      const server = spawn(process.execPath, [SERVER], {
        env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DMS_DEV: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      context.after(() => server.kill());
      let output = "";
      const port = await new Promise<number>((settle, fail) => {
        server.stdout.on("data", (chunk: Buffer) => {
          output += chunk;
          const match = output.match(READY);
          if (match) settle(Number(match[1]));
        });
        server.stderr.on("data", (chunk: Buffer) => (output += chunk));
        server.on("exit", (code) =>
          fail(new Error(`server exited (${code}) before ready: ${output}`)),
        );
      });
      await new Promise<void>((settle, fail) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.end();
          settle();
        });
        socket.on("error", fail);
      });
      assert.ok(port > 0);
    },
  );
});
