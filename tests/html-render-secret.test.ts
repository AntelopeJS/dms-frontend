import * as assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonicalizeBackendUrl } from "../src/config";
import {
  manifestHtmlRenderSecret,
  resolveHtmlRenderSecret,
} from "../src/html-render-secret";
import type { ManifestModule } from "../src/workspace";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SECRET = "manifest-render-secret";
const SESSION_SECRET = "html-render-secret-test-session-secret";

function dmsModule(serviceSecret: unknown): ManifestModule {
  return {
    name: "@antelopejs/dms-frontend-vue",
    archiveName: "dms.zip",
    priority: 0,
    privateOptions: {
      htmlRender: { serviceSecret } as never,
      oauth: { relaySecret: "relay" },
    },
  };
}

function serviceToken(secret: string): string {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString(
    "base64url",
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      namespace: "html-render-service",
      purpose: "html-render",
      aud: "dms-frontend",
      jti: randomUUID(),
      iat: now,
      exp: now + 300,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest("base64url");
  return `${header}.${payload}.${signature}`;
}

describe("HTML render secret resolution", () => {
  it("reads the secret the backend publishes in the manifest", () => {
    const plain: ManifestModule = {
      name: "@fixture/plain",
      archiveName: "plain.zip",
      priority: 1,
    };
    assert.equal(
      manifestHtmlRenderSecret([plain, dmsModule(MANIFEST_SECRET)]),
      MANIFEST_SECRET,
    );
  });

  it("ignores a module without a usable secret", () => {
    assert.equal(manifestHtmlRenderSecret([]), undefined);
    assert.equal(manifestHtmlRenderSecret([dmsModule(null)]), undefined);
    assert.equal(manifestHtmlRenderSecret([dmsModule("")]), undefined);
    assert.equal(manifestHtmlRenderSecret([dmsModule(42)]), undefined);
  });

  it("falls back to the manifest secret when the environment sets none", () => {
    assert.equal(resolveHtmlRenderSecret(MANIFEST_SECRET, {}), MANIFEST_SECRET);
    assert.equal(
      resolveHtmlRenderSecret(MANIFEST_SECRET, { DMS_HTML_RENDER_SECRET: "" }),
      MANIFEST_SECRET,
    );
    assert.equal(resolveHtmlRenderSecret(undefined, {}), undefined);
  });

  it("lets an explicit DMS_HTML_RENDER_SECRET win over the manifest", () => {
    assert.equal(
      resolveHtmlRenderSecret(MANIFEST_SECRET, {
        DMS_HTML_RENDER_SECRET: "deployment-secret",
      }),
      "deployment-secret",
    );
    assert.equal(
      resolveHtmlRenderSecret(undefined, {
        DMS_HTML_RENDER_SECRET: "deployment-secret",
      }),
      "deployment-secret",
    );
  });
});

/** Waits for the server's ready line and returns the port it announces. */
function readyPort(server: ChildProcess): Promise<number> {
  return new Promise((settle, fail) => {
    let output = "";
    server.stdout!.on("data", (chunk) => {
      output += chunk;
      const match = /Server ready on http:\/\/[^:]+:(\d+)/.exec(output);
      if (match) settle(Number(match[1]));
    });
    server.once("exit", (code) =>
      fail(new Error(`server exited with ${code}: ${output}`)),
    );
  });
}

async function renderStatus(port: number, token: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:${port}/api/html/render`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-dms-service-token": token,
    },
    // An empty template name is refused with 400, but only once the token
    // is accepted: the status tells the two checks apart without a bundle.
    body: '{"templateName":"","props":{}}',
  });
  await response.body?.cancel();
  return response.status;
}

/**
 * The generated server checks the render token the same way in development
 * and in production. It runs here as built, without DMS_DEV, since starting
 * Vite would need a fully installed workspace; the secret it receives comes
 * from the resolution `ajs dms dev` and `ajs dms start` both apply.
 */
describe("the generated server's HTML render route", () => {
  async function withServer(
    env: NodeJS.ProcessEnv,
    check: (port: number) => Promise<void>,
  ): Promise<void> {
    const server = spawn(
      process.execPath,
      [join(REPOSITORY, "templates", "vue", "server.mjs")],
      {
        cwd: join(REPOSITORY, "templates", "vue"),
        env: {
          ...process.env,
          PORT: "0",
          HOST: "127.0.0.1",
          DMS_DEV: undefined,
          DMS_API_BASE_URL: "http://127.0.0.1:9",
          DMS_SESSION_SECRET: SESSION_SECRET,
          DMS_HTML_RENDER_SECRET: resolveHtmlRenderSecret(
            manifestHtmlRenderSecret([dmsModule(MANIFEST_SECRET)]),
            env,
          ),
        },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    try {
      await check(await readyPort(server));
    } finally {
      if (server.exitCode === null) {
        const exited = new Promise((settle) => server.once("exit", settle));
        server.kill();
        await exited;
      }
    }
  }

  it("accepts a render signed with the secret the manifest publishes", async () => {
    await withServer({}, async (port) => {
      assert.equal(
        await renderStatus(port, serviceToken(MANIFEST_SECRET)),
        400,
      );
      assert.equal(await renderStatus(port, serviceToken("forged")), 401);
    });
  });

  it("verifies renders against an explicit DMS_HTML_RENDER_SECRET instead", async () => {
    await withServer(
      { DMS_HTML_RENDER_SECRET: "deployment-secret" },
      async (port) => {
        assert.equal(
          await renderStatus(port, serviceToken("deployment-secret")),
          400,
        );
        assert.equal(
          await renderStatus(port, serviceToken(MANIFEST_SECRET)),
          401,
        );
      },
    );
  });
});

describe("ajs dms start", () => {
  const BACKEND_URL = "http://127.0.0.1:5010";

  /**
   * Runs `start` against a built workspace whose server only reports whether
   * the real token check accepts a token signed with the manifest's secret.
   */
  async function start(env: Record<string, string>): Promise<{
    secret?: string;
    accepted: boolean;
  }> {
    const home = mkdtempSync(join(tmpdir(), "dms-render-secret-"));
    try {
      const workspace = join(
        home,
        ".antelopejs",
        "dms-frontend",
        createHash("sha256")
          .update(canonicalizeBackendUrl(BACKEND_URL))
          .digest("hex"),
      );
      mkdirSync(join(workspace, "dist", "client"), { recursive: true });
      writeFileSync(join(workspace, "dist", "client", "index.html"), "");
      writeFileSync(
        join(workspace, ".manifest-cache.json"),
        JSON.stringify({
          manifest: { pack: "pack", modules: [dmsModule(MANIFEST_SECRET)] },
          fetchedAt: new Date().toISOString(),
        }),
      );
      const renderToken = pathToFileURL(
        join(REPOSITORY, "templates", "vue", "server", "render-token.mjs"),
      ).href;
      writeFileSync(
        join(workspace, "server.mjs"),
        `import { validRenderToken } from ${JSON.stringify(renderToken)};\n` +
          "console.log(JSON.stringify({ secret: process.env.DMS_HTML_RENDER_SECRET, " +
          "accepted: validRenderToken(process.env.TEST_RENDER_TOKEN) }));\n",
      );

      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        NO_UPDATE_NOTIFIER: "1",
        DMS_SESSION_SECRET: SESSION_SECRET,
        TEST_RENDER_TOKEN: serviceToken(MANIFEST_SECRET),
        ...env,
      };
      if (!("DMS_HTML_RENDER_SECRET" in env))
        delete environment.DMS_HTML_RENDER_SECRET;
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          require.resolve("tsx"),
          join(REPOSITORY, "src", "index.ts"),
          "start",
          "-b",
          BACKEND_URL,
        ],
        { cwd: home, env: environment },
      );
      const report = stdout.split("\n").find((line) => line.startsWith("{"));
      assert.ok(report, stdout);
      return JSON.parse(report);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("hands the server the secret the build's manifest published", async () => {
    assert.deepEqual(await start({}), {
      secret: MANIFEST_SECRET,
      accepted: true,
    });
  });

  it("keeps an explicit DMS_HTML_RENDER_SECRET", async () => {
    assert.deepEqual(
      await start({ DMS_HTML_RENDER_SECRET: "deployment-secret" }),
      { secret: "deployment-secret", accepted: false },
    );
  });
});
