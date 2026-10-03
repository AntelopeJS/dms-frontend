import * as assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { connect, createServer, type Server } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";

const SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../templates/vue/server.mjs",
);
const READY = /✓ Server ready on http:\/\/127\.0\.0\.1:(\d+)/;

interface Started {
  server: ChildProcess;
  output: () => string;
  exited: Promise<number | null>;
}

/** Starts the server as the CLI does when `ipc` is set, on its own otherwise. */
function startServer(
  context: TestContext,
  port: number,
  ipc: boolean,
): Started {
  const server = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      DMS_DEV: "",
    },
    stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])],
  });
  context.after(() => server.kill());
  let output = "";
  server.stdout!.on("data", (chunk: Buffer) => (output += chunk));
  server.stderr!.on("data", (chunk: Buffer) => (output += chunk));
  const exited = new Promise<number | null>((settle) =>
    server.on("exit", (code) => settle(code)),
  );
  return { server, output: () => output, exited };
}

/** The first message the server sends over IPC. */
function firstMessage(started: Started): Promise<Record<string, unknown>> {
  return new Promise((settle, fail) => {
    started.server.once("message", (message) =>
      settle(message as Record<string, unknown>),
    );
    void started.exited.then((code) =>
      fail(new Error(`server exited (${code}): ${started.output()}`)),
    );
  });
}

function canConnect(port: number): Promise<void> {
  return new Promise((settle, fail) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.end();
      settle();
    });
    socket.on("error", fail);
  });
}

function occupiedPort(context: TestContext): Promise<number> {
  return new Promise((settle) => {
    const holder: Server = createServer();
    context.after(() => holder.close());
    holder.listen(0, "127.0.0.1", () => {
      const address = holder.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      settle(address.port);
    });
  });
}

describe("Frontend server startup", () => {
  it(
    "reports to the CLI over IPC once it accepts connections",
    { timeout: 15_000 },
    async (context) => {
      const started = startServer(context, 0, true);
      const message = await firstMessage(started);
      assert.equal(message.type, "dms:ready");
      assert.equal(message.address, "127.0.0.1");
      assert.equal(typeof message.port, "number");
      await canConnect(message.port as number);
      assert.doesNotMatch(started.output(), READY);
    },
  );

  it(
    "prints its ready line when started on its own",
    { timeout: 15_000 },
    async (context) => {
      const started = startServer(context, 0, false);
      const port = await new Promise<number>((settle, fail) => {
        started.server.stdout!.on("data", () => {
          const match = started.output().match(READY);
          if (match) settle(Number(match[1]));
        });
        void started.exited.then((code) =>
          fail(new Error(`server exited (${code}): ${started.output()}`)),
        );
      });
      await canConnect(port);
    },
  );

  it(
    "reports a port it cannot listen on, then exits",
    { timeout: 15_000 },
    async (context) => {
      const port = await occupiedPort(context);
      const started = startServer(context, port, true);
      const message = await firstMessage(started);
      assert.deepEqual(
        { ...message, message: undefined },
        {
          type: "dms:listen-error",
          code: "EADDRINUSE",
          message: undefined,
          host: "127.0.0.1",
          port,
        },
      );
      assert.equal(await started.exited, 1);
      assert.doesNotMatch(started.output(), /Unhandled 'error' event/);
    },
  );

  it(
    "says why it cannot listen when started on its own",
    { timeout: 15_000 },
    async (context) => {
      const port = await occupiedPort(context);
      const started = startServer(context, port, false);
      assert.equal(await started.exited, 1);
      assert.match(
        started.output(),
        new RegExp(
          `DMS server cannot listen on 127\\.0\\.0\\.1:${port}: .*EADDRINUSE`,
        ),
      );
      assert.doesNotMatch(started.output(), /Unhandled 'error' event|\n\s+at /);
    },
  );
});
