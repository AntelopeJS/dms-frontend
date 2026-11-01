import * as assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, type TestContext } from "node:test";
import { listenHost } from "../templates/vue/server/listen-host.mjs";
import { addressOf } from "./helpers/net";
import { isNumber } from "./helpers/guards";
import { isJsonObject, isJsonValue, type JsonObject } from "./helpers/json";

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

interface StartOptions {
  /** Where the server starts, and Vite finds its config. */
  cwd?: string;
  /** Starts Vite with the server, as `ajs dms dev` does. */
  isDev?: boolean;
  /** `HOST`, `127.0.0.1` by default; `null` leaves it unset. */
  host?: string | null;
}

/** The servers each test started, stopped before anything else is cleaned up. */
const startedServers = new WeakMap<TestContext, Started[]>();

/** Stops every server `context` started and waits for each to exit. */
async function stopServers(context: TestContext): Promise<void> {
  const servers = startedServers.get(context) ?? [];
  startedServers.delete(context);
  await Promise.all(
    servers.map(async ({ server, exited }) => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      server.kill();
      const forced = setTimeout(() => server.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(forced);
    }),
  );
}

/**
 * A directory a server runs in, removed once the test is over. The servers
 * are stopped first: a development server keeps writing Vite's cache into
 * its directory, and a removal that fails then must fail the test, not leave
 * the server running and the whole suite waiting for it.
 */
function serverDirectory(context: TestContext, prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  context.after(async () => {
    await stopServers(context);
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/** Starts the server as the CLI does when `ipc` is set, on its own otherwise. */
function startServer(
  context: TestContext,
  port: number,
  ipc: boolean,
  { cwd, isDev = false, host = "127.0.0.1" }: StartOptions = {},
): Started {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DMS_DEV: isDev ? "true" : "",
  };
  if (host === null) delete env.HOST;
  else env.HOST = host;
  const server = spawn(process.execPath, [SERVER], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc" as const] : [])],
  });
  let output = "";
  server.stdout!.on("data", (chunk: Buffer) => (output += chunk));
  server.stderr!.on("data", (chunk: Buffer) => (output += chunk));
  const exited = new Promise<number | null>((settle) =>
    server.on("exit", (code) => settle(code)),
  );
  const started = { server, output: () => output, exited };
  startedServers.set(context, [
    ...(startedServers.get(context) ?? []),
    started,
  ]);
  context.after(() => stopServers(context));
  return started;
}

/** The first message the server sends over IPC. */
function firstMessage(started: Started): Promise<JsonObject> {
  return new Promise((settle, fail) => {
    started.server.once("message", (message) => {
      if (isJsonValue(message) && isJsonObject(message)) settle(message);
      else fail(new Error("the server sent a message that is not an object"));
    });
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
      const address = addressOf(holder);
      settle(address.port);
    });
  });
}

describe("Frontend server address", () => {
  it("listens on the loopback address in development unless HOST says otherwise", () => {
    assert.equal(listenHost({ DMS_DEV: "true" }), "127.0.0.1");
    assert.equal(listenHost({ DMS_DEV: "true", HOST: "0.0.0.0" }), "0.0.0.0");
    assert.equal(listenHost({ DMS_DEV: "true", HOST: " " }), "127.0.0.1");
  });

  it("listens on every interface in production unless HOST says otherwise", () => {
    assert.equal(listenHost({}), "0.0.0.0");
    assert.equal(listenHost({ HOST: "10.0.0.2" }), "10.0.0.2");
  });

  it(
    "starts the development server on the loopback address without HOST",
    { timeout: 30_000 },
    async (context) => {
      const root = serverDirectory(context, "dms-dev-host-");
      writeFileSync(join(root, "vite.config.mjs"), "export default {};\n");
      const started = startServer(context, 0, true, {
        cwd: root,
        isDev: true,
        host: null,
      });
      const message = await firstMessage(started);
      assert.equal(message.type, "dms:ready");
      assert.equal(message.address, "127.0.0.1");
    },
  );
});

describe("Frontend server startup", () => {
  it(
    "reports to the CLI over IPC once it accepts connections",
    { timeout: 15_000 },
    async (context) => {
      const started = startServer(context, 0, true);
      const message = await firstMessage(started);
      assert.equal(message.type, "dms:ready");
      assert.equal(message.address, "127.0.0.1");
      assert.ok(isNumber(message.port));
      await canConnect(message.port);
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
      await assert.doesNotReject(canConnect(port));
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

  it(
    "reports a Vite that could not start, where it failed, then exits",
    { timeout: 30_000 },
    async (context) => {
      const root = serverDirectory(context, "dms-vite-start-");
      const config = join(root, "vite.config.ts");
      writeFileSync(config, "export default {\n  plugins: [,\n  broken(\n};\n");

      const started = startServer(context, 0, true, { cwd: root, isDev: true });
      const message = await firstMessage(started);
      assert.deepEqual(message, {
        type: "dms:start-error",
        message: "Unexpected token",
        location: { file: config, line: 4, column: 0, lineText: "};" },
      });
      assert.equal(await started.exited, 1);
      assert.doesNotMatch(started.output(), /\n\s+at /);
    },
  );

  it(
    "reports where a startup error points only by the numbers it carries",
    { timeout: 30_000 },
    async (context) => {
      const root = serverDirectory(context, "dms-vite-start-");
      const config = join(root, "vite.config.ts");
      writeFileSync(
        config,
        `const error = new Error("config boom");
Object.assign(error, { loc: { file: ${JSON.stringify(config)}, line: "1", column: { at: 2 } } });
throw error;
`,
      );

      const started = startServer(context, 0, true, { cwd: root, isDev: true });
      const message = await firstMessage(started);
      assert.deepEqual(message, {
        type: "dms:start-error",
        message: "config boom",
        location: { file: config },
      });
      assert.equal(await started.exited, 1);
    },
  );

  it(
    "says why Vite could not start when started on its own",
    { timeout: 30_000 },
    async (context) => {
      const root = serverDirectory(context, "dms-vite-start-");
      writeFileSync(
        join(root, "vite.config.ts"),
        'throw new Error("config boom");\nexport default {};\n',
      );

      const started = startServer(context, 0, false, {
        cwd: root,
        isDev: true,
      });
      assert.equal(await started.exited, 1);
      assert.match(
        started.output(),
        /DMS development server failed to start: config boom\n/,
      );
      assert.doesNotMatch(started.output(), /\n\s+at |Server ready/);
    },
  );
});
