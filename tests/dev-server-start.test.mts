import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { addressOf } from "./helpers/net";

const SERVER = resolve("templates/vue/server.mjs");
const READY = /Server ready on http:\/\/127\.0\.0\.1:(\d+)/;
const BROKEN = "DMS_TEST_VITE_CONFIG_BROKEN";
const STARTS = "DMS_TEST_VITE_STARTS";
/** Counts each Vite start in `STARTS`, and fails while `BROKEN` is set. */
const COUNTING_VITE_CONFIG = `process.env.${STARTS} = String(Number(process.env.${STARTS} ?? 0) + 1);
if (process.env.${BROKEN}) throw new Error("broken Vite config");
export default { logLevel: "silent", optimizeDeps: { noDiscovery: true }, server: { watch: null, ws: false } };
`;

function projectRoot(viteConfig: string): string {
  const root = mkdtempSync(join(tmpdir(), "dms-dev-start-"));
  writeFileSync(join(root, "vite.config.mjs"), viteConfig);
  return root;
}

function removeRoot(root: string): void {
  assert.equal(existsSync(join(root, ".vite")), false, "Vite wrote no cache");
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  return `http://127.0.0.1:${addressOf(server).port}`;
}

/** Starts the server in `root`; the root is removed once the server has exited. */
async function startDevServer(
  context: TestContext,
  root: string,
): Promise<number> {
  const server = spawn(process.execPath, [SERVER], {
    cwd: root,
    env: { ...process.env, PORT: "0", HOST: "127.0.0.1", DMS_DEV: "true" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise((settle) => server.once("exit", settle));
  context.after(async () => {
    server.kill();
    await exited;
    removeRoot(root);
  });
  let stdout = "";
  let stderr = "";
  server.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
  return await new Promise<number>((settle, fail) => {
    server.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      const match = stdout.match(READY);
      if (match) settle(Number(match[1]));
    });
    server.on("exit", (code) =>
      fail(new Error(`server exited (${code}) before ready: ${stderr}`)),
    );
  });
}

/** The status line the server answers a Vite HMR websocket handshake with. */
function hmrHandshake(port: number): Promise<string> {
  return new Promise((settle, fail) => {
    let answer = "";
    const socket = connect(port, "127.0.0.1", () =>
      socket.write(
        `GET /?token= HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          "Connection: Upgrade\r\nUpgrade: websocket\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Protocol: vite-hmr\r\n\r\n",
      ),
    );
    socket.setTimeout(5_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      answer += chunk;
      if (answer.includes("\r\n")) socket.destroy();
    });
    socket.on("close", () => settle(answer.split("\r\n")[0] ?? ""));
    socket.on("error", fail);
  });
}

void describe("the development server's Vite instance", () => {
  void it(
    "answers the HMR websocket on the frontend port",
    { timeout: 30_000 },
    async (context) => {
      const root = projectRoot(
        "export default { logLevel: 'silent', optimizeDeps: { noDiscovery: true }, server: { watch: null } };",
      );
      const port = await startDevServer(context, root);
      assert.match(await hmrHandshake(port), /^HTTP\/1\.1 101 /);
    },
  );

  void it(
    "starts Vite again after a failed start, once for concurrent requests",
    { timeout: 30_000 },
    async (context) => {
      const root = projectRoot(COUNTING_VITE_CONFIG);
      process.env[BROKEN] = "true";
      const previousCwd = process.cwd();
      const previousDev = process.env.DMS_DEV;
      process.env.DMS_DEV = "true";
      process.chdir(root);
      const runtime = await import("../templates/vue/server.mjs");
      const frontend = createServer(runtime.handleRequestSafely);
      context.after(() => {
        frontend.close();
        process.chdir(previousCwd);
        process.env.DMS_DEV = previousDev;
        removeRoot(root);
      });
      const base = await listen(frontend);
      const failed = await fetch(`${base}/@vite/client`);
      await failed.body?.cancel();
      assert.equal(failed.status, 500);
      const starts = () => Number(process.env[STARTS]);
      const startsBefore = starts();
      delete process.env[BROKEN];
      const responses = await Promise.all(
        [1, 2, 3].map(() => fetch(`${base}/@vite/client`)),
      );
      for (const response of responses) {
        await response.body?.cancel();
        assert.equal(response.status, 200);
      }
      assert.equal(
        starts() - startsBefore,
        1,
        "the three concurrent requests share one start",
      );
    },
  );
});
