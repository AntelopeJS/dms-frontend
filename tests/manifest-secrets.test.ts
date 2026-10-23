import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  collectManifestSecrets,
  describeSecretSources,
  formatSecretConflicts,
  MANIFEST_SECRET_ENV,
  reportManifestSecrets,
  resolveManifestSecrets,
} from "../src/manifest-secrets";
import type { ManifestModule } from "../src/workspace";
import { memoryUi } from "./fixtures/memory-ui";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_SECRET = "manifest-render-secret";
const RELAY_SECRET = "manifest-relay-secret";
const SESSION_SECRET = "html-render-secret-test-session-secret";
const OWN_VERSION: string = JSON.parse(
  readFileSync(join(REPOSITORY, "package.json"), "utf8"),
).version;

function dmsModule(
  serviceSecret: unknown,
  relaySecret: unknown = RELAY_SECRET,
  overrides: Partial<ManifestModule> = {},
): ManifestModule {
  return {
    name: "@antelopejs/dms-frontend-vue",
    priority: 0,
    privateOptions: {
      htmlRender: { serviceSecret } as never,
      oauth: { relaySecret } as never,
    },
    ...overrides,
  };
}
describe("manifest secrets resolution", () => {
  const plain: ManifestModule = {
    name: "@fixture/plain",
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

  it("lets the manifest win, a variable filling in a secret it leaves out", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([dmsModule(MANIFEST_SECRET, null)]),
      {
        DMS_HTML_RENDER_SECRET: "deployment-secret",
        DMS_OAUTH_RELAY_SECRET: "deployment-relay",
      },
    );
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: MANIFEST_SECRET,
      DMS_OAUTH_RELAY_SECRET: "deployment-relay",
    });
    assert.deepEqual(resolved.sources, {
      DMS_HTML_RENDER_SECRET: "manifest",
      DMS_OAUTH_RELAY_SECRET: "env",
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

    // A variable does not settle a value the manifest publishes.
    assert.deepEqual(
      resolveManifestSecrets(secrets, { DMS_HTML_RENDER_SECRET: "set" })
        .conflicts,
      resolved.conflicts,
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

describe("the server secrets report", () => {
  it("groups the secrets the server receives by where they come from", () => {
    assert.equal(
      describeSecretSources({
        DMS_HTML_RENDER_SECRET: "env",
        DMS_OAUTH_RELAY_SECRET: "manifest",
      }),
      "DMS_HTML_RENDER_SECRET from the environment; DMS_OAUTH_RELAY_SECRET from the manifest",
    );
    assert.equal(
      describeSecretSources(
        {
          DMS_HTML_RENDER_SECRET: "manifest",
          DMS_OAUTH_RELAY_SECRET: "manifest",
        },
        "the build-time manifest",
      ),
      "DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the build-time manifest",
    );
    assert.equal(
      describeSecretSources({
        DMS_HTML_RENDER_SECRET: "not set",
        DMS_OAUTH_RELAY_SECRET: "not set",
      }),
      undefined,
    );
  });

  it("warns about each missing secret with what it costs, then how to set them", () => {
    const memory = memoryUi();
    reportManifestSecrets(
      resolveManifestSecrets(collectManifestSecrets([]), {}),
      (count) => `Set the ${count}`,
      memory.ui,
    );
    assert.equal(memory.stdout(), "");
    assert.equal(
      memory.stderr(),
      "▲ DMS_HTML_RENDER_SECRET is not set: e-mail renders will be refused\n" +
        "▲ DMS_OAUTH_RELAY_SECRET is not set: OAuth sign-in will be refused by the backend\n" +
        "  → Set the 2\n",
    );
  });

  it("says nothing about the secrets the server receives", () => {
    const memory = memoryUi();
    reportManifestSecrets(
      resolveManifestSecrets(
        collectManifestSecrets([dmsModule(MANIFEST_SECRET)]),
        {},
      ),
      () => "unused",
      memory.ui,
    );
    assert.equal(memory.stderr(), "");
  });

  it("never prints a secret value", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([
        dmsModule(MANIFEST_SECRET, null),
        dmsModule("other-render", null, {
          name: "@fixture/other",
          priority: -1,
        }),
      ]),
      { DMS_OAUTH_RELAY_SECRET: "deployment-relay" },
    );
    const memory = memoryUi();
    reportManifestSecrets(resolved, () => "unused", memory.ui);
    const output = `${memory.stderr()}${describeSecretSources(resolved.sources)}`;
    assert.match(output, /@fixture\/other/);
    assert.match(output, /DMS_OAUTH_RELAY_SECRET from the environment/);
    for (const value of [
      MANIFEST_SECRET,
      "other-render",
      RELAY_SECRET,
      "deployment-relay",
    ])
      assert.ok(!output.includes(value), `leaked ${value}`);
  });
});

describe("ajs dms start", () => {
  const BACKEND_URL = "http://127.0.0.1:5010";
  const PUBLIC_KEY_VARIABLE = "FIXTURE_PUBLIC_KEY";
  const SERVER_LIFETIME_MS = 1000;

  interface StartReport {
    secret?: string;
    relay?: string;
    publicOptions?: string;
  }

  /**
   * A project whose one module computes its frontend's public options from
   * its configuration, which an environment variable overrides.
   */
  function writeProject(project: string): void {
    const module = join(project, "modules", "fixture");
    mkdirSync(join(module, "frontend-vue"), { recursive: true });
    writeFileSync(
      join(module, "package.json"),
      JSON.stringify({
        name: "@fixture/module",
        version: "1.2.3",
        dmsFrontend: "frontend-module.js",
      }),
    );
    writeFileSync(
      join(module, "frontend-vue", "package.json"),
      JSON.stringify({ name: "@fixture/module-frontend-vue" }),
    );
    writeFileSync(
      join(module, "frontend-module.js"),
      `exports.frontendModule = (config, context) => ({
  name: "@fixture/module-frontend-vue",
  sourcePath: require("node:path").join(__dirname, "frontend-vue"),
  renderer: { name: "vue", version: "3" },
  configKey: "fixture",
  options: { key: config.key, api: config.api, undeclared: config.undeclared, dev: context.dev },
});\n`,
    );
    // The api module as it ships: the pure function its provide() reuses.
    const api = join(project, "modules", "api");
    mkdirSync(api, { recursive: true });
    writeFileSync(
      join(api, "package.json"),
      JSON.stringify({
        name: "@fixture/api",
        version: "1.0.0",
        antelopeJs: {
          configVars: ["API_PUBLIC_BASE_URL"],
          configVarsFile: "config-vars.js",
        },
      }),
    );
    writeFileSync(
      join(api, "config-vars.js"),
      `exports.configVars = (config) => ({
  API_PUBLIC_BASE_URL: config.publicBaseUrl.replace(/\\/+$/, ""),
  UNDECLARED: "not published",
});\n`,
    );
    writeFileSync(
      join(project, "antelope.config.ts"),
      `export default {
  name: "fixture",
  envOverrides: { ${PUBLIC_KEY_VARIABLE}: "modules.fixture.config.key" },
  modules: {
    fixture: { source: { type: "local", path: "modules/fixture" }, config: { key: "from-config", api: "\${@api.API_PUBLIC_BASE_URL}/api", undeclared: "\${@api.UNDECLARED}" } },
    api: { source: { type: "local", path: "modules/api" }, config: { publicBaseUrl: "https://api.example.com/", servers: [{ protocol: "http", port: 5010 }] } },
  },
};\n`,
    );
  }

  /**
   * Runs `start` from a project holding a built workspace whose server only
   * reports what it received. Returns that report and the CLI's own output.
   */
  async function start(
    env: Record<string, string>,
    serverOptions?: Record<string, unknown>,
    backendUrl = BACKEND_URL,
  ): Promise<{ report: StartReport; log: string }> {
    const project = mkdtempSync(join(tmpdir(), "dms-manifest-secrets-"));
    try {
      writeProject(project);
      const workspace = join(project, ".dms-frontend");
      mkdirSync(join(workspace, "dist", "client"), { recursive: true });
      writeFileSync(join(workspace, "dist", "client", "index.html"), "");
      if (serverOptions)
        writeFileSync(
          join(workspace, "generated-server-options.json"),
          JSON.stringify({ modules: serverOptions }),
        );
      writeFileSync(
        join(workspace, "server.mjs"),
        'process.send({ type: "dms:ready", address: "127.0.0.1", port: 3321 });\n' +
          "console.log(JSON.stringify({ secret: process.env.DMS_HTML_RENDER_SECRET, " +
          "relay: process.env.DMS_OAUTH_RELAY_SECRET, publicOptions: process.env.DMS_PUBLIC_OPTIONS }));\n" +
          // Up long enough for the CLI to hear the backend take its report.
          `setTimeout(() => {}, ${SERVER_LIFETIME_MS});\n`,
      );

      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: project,
        USERPROFILE: project,
        NO_UPDATE_NOTIFIER: "1",
        // start reserves its port before spawning the server: ask for any
        // free one, so the suite does not depend on 3001 being free.
        PORT: "0",
        DMS_SESSION_SECRET: SESSION_SECRET,
        ...env,
      };
      for (const name of [
        ...Object.keys(MANIFEST_SECRET_ENV),
        "DMS_PRIVATE_OPTIONS",
        PUBLIC_KEY_VARIABLE,
      ])
        if (!(name in env)) delete environment[name];
      const { stdout, stderr } = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          pathToFileURL(require.resolve("tsx")).href,
          join(REPOSITORY, "src", "index.ts"),
          "start",
          "-b",
          backendUrl,
        ],
        { cwd: project, env: environment },
      );
      // stdout belongs to the server alone: the CLI reports on stderr.
      return { report: JSON.parse(stdout), log: stderr };
    } finally {
      rmSync(project, { recursive: true, force: true });
    }
  }

  it("computes the modules' public options from the project and the variables it runs with", async () => {
    const fromConfig = await start({});
    assert.deepEqual(JSON.parse(fromConfig.report.publicOptions ?? "{}"), {
      "fixture__module-frontend-vue": {
        fixture: {
          key: "from-config",
          api: "https://api.example.com/api",
          dev: false,
        },
      },
    });
    const overridden = await start({ [PUBLIC_KEY_VARIABLE]: "from-variable" });
    assert.deepEqual(JSON.parse(overridden.report.publicOptions ?? "{}"), {
      "fixture__module-frontend-vue": {
        fixture: {
          key: "from-variable",
          api: "https://api.example.com/api",
          dev: false,
        },
      },
    });
  });

  it("says whether the backend took or refused the ready report", async () => {
    const backend = createServer((request, response) => {
      const isAuthorized = request.headers["x-dms-bootstrap"] === "right";
      response.statusCode = isAuthorized ? 204 : 401;
      response.end();
    });
    await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done));
    const { port } = backend.address() as AddressInfo;
    const backendUrl = `http://127.0.0.1:${port}`;
    try {
      const taken = await start(
        { DMS_BOOTSTRAP_SECRET: "right" },
        undefined,
        backendUrl,
      );
      assert.match(
        taken.log,
        new RegExp(
          `\\[DMS\\] Reported 1 modules to the backend \\(dms-frontend ${OWN_VERSION.replace(/\\./g, "\\\\.")}\\)\\n`,
        ),
      );
      const refused = await start(
        { DMS_BOOTSTRAP_SECRET: "wrong" },
        undefined,
        backendUrl,
      );
      assert.match(
        refused.log,
        /▲ \[DMS\] The backend refused the ready report: it cannot check this build's module versions\n {2}→ Set DMS_BOOTSTRAP_SECRET to the backend's frontend.bootstrapSecret/,
      );
    } finally {
      backend.close();
    }
  });

  it("hands the server the secrets of its environment, and names their source", async () => {
    const { report, log } = await start({
      DMS_HTML_RENDER_SECRET: "deployment-secret",
      DMS_OAUTH_RELAY_SECRET: "deployment-relay",
    });
    assert.equal(report.secret, "deployment-secret");
    assert.equal(report.relay, "deployment-relay");
    assert.match(
      log,
      /Secrets: +DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the environment\n/,
    );
    assert.ok(!log.includes("deployment-"));
  });

  it("starts the server without secrets and says what they cost", async () => {
    const { report, log } = await start({});
    assert.equal(report.secret, undefined);
    assert.equal(report.relay, undefined);
    assert.match(
      log,
      /▲ DMS_HTML_RENDER_SECRET is not set: e-mail renders will be refused\n/,
    );
    assert.match(
      log,
      /▲ DMS_OAUTH_RELAY_SECRET is not set: OAuth sign-in will be refused by the backend\n {2}→ Set them in the server's environment, with the values the backend uses/,
    );
    assert.doesNotMatch(log, /Secrets:/);
  });

  it("names each module option the server would get empty, until DMS_PRIVATE_OPTIONS sets it", async () => {
    const built = {
      "acme__shop-frontend-vue": {
        apiKey: "",
        webhook: { token: "" },
        keys: [""],
        htmlRender: { serviceSecret: "" },
      },
    };
    const unset = await start({}, built);
    assert.match(
      unset.log,
      /▲ acme__shop-frontend-vue: private option apiKey is not set\n▲ acme__shop-frontend-vue: private option webhook\.token is not set\n▲ acme__shop-frontend-vue: private option keys\.0 is not set\n {2}→ Set them in DMS_PRIVATE_OPTIONS/,
    );
    assert.doesNotMatch(unset.log, /private option htmlRender/);

    const set = await start(
      {
        DMS_PRIVATE_OPTIONS: JSON.stringify({
          "acme__shop-frontend-vue": {
            apiKey: "shop-api-key",
            webhook: { token: "" },
          },
        }),
      },
      built,
    );
    assert.doesNotMatch(set.log, /private option apiKey/);
    assert.match(set.log, /private option webhook.token is not set/);
    assert.ok(!set.log.includes("shop-api-key"));
  });

  it("refuses a DMS_PRIVATE_OPTIONS that is not options by module id, without repeating it", async () => {
    await assert.rejects(
      start({
        DMS_PRIVATE_OPTIONS: '{"acme__shop-frontend-vue":"leaked-value"}',
      }),
      (error: { stderr: string }) => {
        assert.match(
          error.stderr,
          /DMS_PRIVATE_OPTIONS is not a JSON object of options by module id/,
        );
        assert.ok(!error.stderr.includes("leaked-value"));
        return true;
      },
    );
  });
});
