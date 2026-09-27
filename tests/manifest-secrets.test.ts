import * as assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { canonicalizeBackendUrl } from "../src/config";
import {
  collectManifestSecrets,
  formatSecretConflicts,
  formatSecretSources,
  MANIFEST_SECRET_ENV,
  reportManifestSecrets,
  resolveManifestSecrets,
} from "../src/manifest-secrets";
import type { ManifestModule } from "../src/workspace";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SECRET = "manifest-render-secret";
const RELAY_SECRET = "manifest-relay-secret";
const SESSION_SECRET = "html-render-secret-test-session-secret";

function dmsModule(
  serviceSecret: unknown,
  relaySecret: unknown = RELAY_SECRET,
  overrides: Partial<ManifestModule> = {},
): ManifestModule {
  return {
    name: "@antelopejs/dms-frontend-vue",
    archiveName: "dms.zip",
    priority: 0,
    privateOptions: {
      htmlRender: { serviceSecret } as never,
      oauth: { relaySecret } as never,
    },
    ...overrides,
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

describe("manifest secrets resolution", () => {
  const plain: ManifestModule = {
    name: "@fixture/plain",
    archiveName: "plain.zip",
    priority: 1,
  };

  it("maps each variable of the closed table to its manifest path", () => {
    assert.deepEqual(MANIFEST_SECRET_ENV, {
      DMS_HTML_RENDER_SECRET: ["htmlRender", "serviceSecret"],
      DMS_OAUTH_RELAY_SECRET: ["oauth", "relaySecret"],
    });
  });

  it("reads both secrets the backend publishes in the manifest", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([plain, dmsModule(MANIFEST_SECRET)]),
      {},
    );
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: MANIFEST_SECRET,
      DMS_OAUTH_RELAY_SECRET: RELAY_SECRET,
    });
    assert.deepEqual(resolved.sources, {
      DMS_HTML_RENDER_SECRET: "manifest",
      DMS_OAUTH_RELAY_SECRET: "manifest",
    });
    assert.deepEqual(resolved.conflicts, []);
  });

  it("ignores values that are not a non-empty string", () => {
    for (const value of [null, "", 42, { nested: "x" }]) {
      const resolved = resolveManifestSecrets(
        collectManifestSecrets([dmsModule(value, value)]),
        {},
      );
      assert.deepEqual(resolved.env, {});
      assert.deepEqual(resolved.sources, {
        DMS_HTML_RENDER_SECRET: "not set",
        DMS_OAUTH_RELAY_SECRET: "not set",
      });
    }
    assert.deepEqual(
      resolveManifestSecrets(collectManifestSecrets([]), {}).env,
      {},
    );
  });

  it("lets an explicit variable win over the manifest", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([dmsModule(MANIFEST_SECRET)]),
      {
        DMS_HTML_RENDER_SECRET: "deployment-secret",
        DMS_OAUTH_RELAY_SECRET: "",
      },
    );
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: "deployment-secret",
      DMS_OAUTH_RELAY_SECRET: RELAY_SECRET,
    });
    assert.deepEqual(resolved.sources, {
      DMS_HTML_RENDER_SECRET: "env",
      DMS_OAUTH_RELAY_SECRET: "manifest",
    });
    assert.equal(
      resolveManifestSecrets(collectManifestSecrets([]), {
        DMS_OAUTH_RELAY_SECRET: "deployment-relay",
      }).env.DMS_OAUTH_RELAY_SECRET,
      "deployment-relay",
    );
  });

  it("takes the first value in manifest priority order and reports a conflict", () => {
    const low = dmsModule("low-render", "low-relay", {
      name: "@fixture/low",
      priority: 1,
    });
    const high = dmsModule("high-render", null, {
      name: "@fixture/high",
      priority: 5,
    });
    const same = dmsModule("high-render", "", {
      name: "@fixture/same",
      priority: 3,
    });
    const secrets = collectManifestSecrets([low, same, high]);
    const resolved = resolveManifestSecrets(secrets, {});
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: "high-render",
      DMS_OAUTH_RELAY_SECRET: "low-relay",
    });
    assert.deepEqual(resolved.conflicts, [
      {
        name: "DMS_HTML_RENDER_SECRET",
        used: "@fixture/high",
        ignored: ["@fixture/low"],
      },
    ]);
    const warnings = formatSecretConflicts(resolved.conflicts);
    assert.deepEqual(warnings, [
      "DMS_HTML_RENDER_SECRET: @fixture/low publishes a different value than @fixture/high; using @fixture/high's",
    ]);
    for (const value of ["high-render", "low-render", "low-relay"])
      assert.ok(!warnings.join("\n").includes(value));

    // An explicit variable settles the value: the conflict no longer matters.
    assert.deepEqual(
      resolveManifestSecrets(secrets, { DMS_HTML_RENDER_SECRET: "set" })
        .conflicts,
      [],
    );
  });

  it("keeps manifest order between modules of equal priority", () => {
    const first = dmsModule("first", null, { name: "@fixture/first" });
    const second = dmsModule("second", null, { name: "@fixture/second" });
    assert.equal(
      resolveManifestSecrets(collectManifestSecrets([first, second]), {}).env
        .DMS_HTML_RENDER_SECRET,
      "first",
    );
  });
});

describe("the server secrets log block", () => {
  it("names each source and the consequence of a missing secret", () => {
    assert.deepEqual(
      formatSecretSources({
        DMS_HTML_RENDER_SECRET: "env",
        DMS_OAUTH_RELAY_SECRET: "manifest",
      }),
      ["DMS_HTML_RENDER_SECRET  env", "DMS_OAUTH_RELAY_SECRET  manifest"],
    );
    assert.deepEqual(
      formatSecretSources(
        {
          DMS_HTML_RENDER_SECRET: "manifest",
          DMS_OAUTH_RELAY_SECRET: "not set",
        },
        "build-time manifest",
      ),
      [
        "DMS_HTML_RENDER_SECRET  build-time manifest",
        "DMS_OAUTH_RELAY_SECRET  not set (OAuth sign-in will be refused by the backend)",
      ],
    );
    assert.deepEqual(
      formatSecretSources({
        DMS_HTML_RENDER_SECRET: "not set",
        DMS_OAUTH_RELAY_SECRET: "env",
      }),
      [
        "DMS_HTML_RENDER_SECRET  not set (e-mail renders will be refused)",
        "DMS_OAUTH_RELAY_SECRET  env",
      ],
    );
  });

  it("never prints a secret value", () => {
    const lines: string[] = [];
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([
        dmsModule(MANIFEST_SECRET),
        dmsModule("other-render", RELAY_SECRET, {
          name: "@fixture/other",
          priority: -1,
        }),
      ]),
      { DMS_OAUTH_RELAY_SECRET: "deployment-relay" },
    );
    reportManifestSecrets(resolved, "manifest", (line) => lines.push(line));
    const output = lines.join("\n");
    assert.match(output, /Server secrets/);
    assert.match(output, /@fixture\/other/);
    for (const value of [
      MANIFEST_SECRET,
      "other-render",
      RELAY_SECRET,
      "deployment-relay",
    ])
      assert.ok(!output.includes(value), `leaked ${value}`);
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

/** Starts a backend stand-in that records the OAuth relay header it gets. */
async function withRelayBackend(
  check: (url: string, relayHeaders: (string | undefined)[]) => Promise<void>,
): Promise<void> {
  const relayHeaders: (string | undefined)[] = [];
  const backend = createServer((request, response) => {
    const relay = request.headers["x-dms-oauth-relay"];
    relayHeaders.push(Array.isArray(relay) ? relay[0] : relay);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ state: "state", authorizeUrl: "https://idp.test/" }),
    );
  });
  await new Promise<void>((settle) =>
    backend.listen(0, "127.0.0.1", () => settle()),
  );
  try {
    const { port } = backend.address() as AddressInfo;
    await check(`http://127.0.0.1:${port}`, relayHeaders);
  } finally {
    await new Promise((settle) => backend.close(settle));
  }
}

/**
 * The generated server checks the render token and relays OAuth calls the
 * same way in development and in production. It runs here as built, without
 * DMS_DEV, since starting Vite would need a fully installed workspace; the
 * secrets it receives come from the resolution `ajs dms dev` and
 * `ajs dms start` both apply.
 */
describe("the generated server's secrets", () => {
  async function withServer(
    env: NodeJS.ProcessEnv,
    check: (port: number) => Promise<void>,
    backendUrl = "http://127.0.0.1:9",
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
          DMS_API_BASE_URL: backendUrl,
          DMS_SESSION_SECRET: SESSION_SECRET,
          DMS_HTML_RENDER_SECRET: undefined,
          DMS_OAUTH_RELAY_SECRET: undefined,
          ...resolveManifestSecrets(
            collectManifestSecrets([dmsModule(MANIFEST_SECRET)]),
            env,
          ).env,
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

  async function oauthStart(port: number): Promise<number> {
    const response = await fetch(
      `http://127.0.0.1:${port}/auth/oauth/google/start`,
      { redirect: "manual" },
    );
    await response.body?.cancel();
    return response.status;
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

  it("presents the manifest's OAuth relay secret to the backend", async () => {
    await withRelayBackend(async (backendUrl, relayHeaders) => {
      await withServer(
        {},
        async (port) => {
          assert.equal(await oauthStart(port), 302);
        },
        backendUrl,
      );
      assert.deepEqual(relayHeaders, [RELAY_SECRET]);
    });
  });

  it("presents an explicit DMS_OAUTH_RELAY_SECRET instead", async () => {
    await withRelayBackend(async (backendUrl, relayHeaders) => {
      await withServer(
        { DMS_OAUTH_RELAY_SECRET: "deployment-relay" },
        async (port) => {
          assert.equal(await oauthStart(port), 302);
        },
        backendUrl,
      );
      assert.deepEqual(relayHeaders, ["deployment-relay"]);
    });
  });
});

describe("ajs dms start", () => {
  const BACKEND_URL = "http://127.0.0.1:5010";

  interface StartReport {
    secret?: string;
    relay?: string;
    accepted: boolean;
  }

  /**
   * Runs `start` against a built workspace whose server only reports the
   * secrets it received and whether the real token check accepts a token
   * signed with the manifest's secret. Returns that report and the CLI's
   * own output.
   */
  async function start(
    env: Record<string, string>,
    modules: ManifestModule[] = [dmsModule(MANIFEST_SECRET)],
  ): Promise<{ report: StartReport; log: string }> {
    const home = mkdtempSync(join(tmpdir(), "dms-manifest-secrets-"));
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
          manifest: { pack: "pack", modules },
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
          "relay: process.env.DMS_OAUTH_RELAY_SECRET, " +
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
      for (const name of Object.keys(MANIFEST_SECRET_ENV))
        if (!(name in env)) delete environment[name];
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
      const lines = stdout.split("\n");
      const report = lines.find((line) => line.startsWith("{"));
      assert.ok(report, stdout);
      return {
        report: JSON.parse(report),
        log: lines.filter((line) => line !== report).join("\n"),
      };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("hands the server the secrets the build's manifest published", async () => {
    const { report, log } = await start({});
    assert.deepEqual(report, {
      secret: MANIFEST_SECRET,
      relay: RELAY_SECRET,
      accepted: true,
    });
    assert.match(log, /DMS_HTML_RENDER_SECRET +build-time manifest/);
    assert.match(log, /DMS_OAUTH_RELAY_SECRET +build-time manifest/);
    assert.ok(!log.includes(MANIFEST_SECRET));
    assert.ok(!log.includes(RELAY_SECRET));
  });

  it("keeps explicit variables", async () => {
    const { report, log } = await start({
      DMS_HTML_RENDER_SECRET: "deployment-secret",
      DMS_OAUTH_RELAY_SECRET: "deployment-relay",
    });
    assert.deepEqual(report, {
      secret: "deployment-secret",
      relay: "deployment-relay",
      accepted: false,
    });
    assert.match(log, /DMS_HTML_RENDER_SECRET +env/);
    assert.match(log, /DMS_OAUTH_RELAY_SECRET +env/);
    assert.ok(!log.includes("deployment-"));
  });

  it("starts the server without secrets and says what they cost", async () => {
    const { report, log } = await start({}, [dmsModule(null, null)]);
    assert.deepEqual(report, { accepted: false });
    assert.match(
      log,
      /DMS_HTML_RENDER_SECRET +not set \(e-mail renders will be refused\)/,
    );
    assert.match(
      log,
      /DMS_OAUTH_RELAY_SECRET +not set \(OAuth sign-in will be refused by the backend\)/,
    );
  });
});
