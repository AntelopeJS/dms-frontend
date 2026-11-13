import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { MANIFEST_SECRET_ENV } from "../src/manifest-secrets";
import type { FrontendModuleOptions } from "../src/workspace";
import { isText } from "./helpers/guards";
import { isJsonObject, isJsonValue, jsonAt } from "./helpers/json";
import { OWN_PACKAGE } from "./helpers/own-package";
import { addressOf } from "./helpers/net";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SESSION_SECRET = "html-render-secret-test-session-secret";

const BACKEND_URL = "http://127.0.0.1:5010";
const PUBLIC_KEY_VARIABLE = "FIXTURE_PUBLIC_KEY";
const SERVER_LIFETIME_MS = 3000;

interface StartReport {
  secret?: string;
  relay?: string;
  publicOptions?: string;
}

function isOptionalText(value: unknown): value is string | undefined {
  return value === undefined || isText(value);
}

function isStartReport(value: unknown): value is StartReport {
  return (
    isJsonValue(value) &&
    isJsonObject(value) &&
    isOptionalText(jsonAt(value, "secret")) &&
    isOptionalText(jsonAt(value, "relay")) &&
    isOptionalText(jsonAt(value, "publicOptions"))
  );
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
  serverOptions?: FrontendModuleOptions,
  backendUrl = BACKEND_URL,
): Promise<{ report: StartReport; log: string }> {
  const project = mkdtempSync(join(tmpdir(), "dms-manifest-secrets-"));
  try {
    writeProject(project);
    const workspace = join(project, ".dms-frontend");
    mkdirSync(join(workspace, "dist", "client"), { recursive: true });
    writeFileSync(join(workspace, "dist", "client", "index.html"), "");
    writeFileSync(
      join(workspace, "generated-frontend-modules.json"),
      JSON.stringify({
        modules: [
          {
            id: "fixture__module-frontend-vue",
            name: "@fixture/module-frontend-vue",
            version: "1.2.3",
          },
        ],
      }),
    );
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
        `setTimeout(() => {}, ${SERVER_LIFETIME_MS});\n`,
    );

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: project,
      USERPROFILE: project,
      NO_UPDATE_NOTIFIER: "1",
      PORT: "0",
      DMS_SESSION_SECRET: SESSION_SECRET,
      ...env,
    };
    for (const name of [
      ...Object.keys(MANIFEST_SECRET_ENV),
      "DMS_PRIVATE_OPTIONS",
      PUBLIC_KEY_VARIABLE,
    ])
      if (!Object.hasOwn(env, name)) delete environment[name];
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
    const report: unknown = JSON.parse(stdout);
    assert.ok(isStartReport(report), "the server reported its secrets");
    return { report, log: stderr };
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

function registerReportTests(): void {
  void it("computes the modules' public options from the project and the variables it runs with", async () => {
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

  void it("says whether the backend took or refused the ready report", async () => {
    const backend = createServer((request, response) => {
      const isAuthorized = request.headers["x-dms-bootstrap"] === "right";
      response.statusCode = isAuthorized ? 204 : 401;
      response.end();
    });
    await new Promise<void>((done) => backend.listen(0, "127.0.0.1", done));
    const { port } = addressOf(backend);
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
          `\\[DMS\\] Reported 1 modules to the backend \\(dms-frontend ${OWN_PACKAGE.version.replace(/\\./g, "\\\\.")}\\)\\n`,
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
}

void describe("ajs dms start", { concurrency: true }, () => {
  registerReportTests();

  void it("hands the server the secrets of its environment, and names their source", async () => {
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

  void it("starts the server without secrets and says what they cost", async () => {
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

  void it("names each module option the server would get empty, until DMS_PRIVATE_OPTIONS sets it", async () => {
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

  void it("refuses a DMS_PRIVATE_OPTIONS that is not options by module id, without repeating it", async () => {
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
