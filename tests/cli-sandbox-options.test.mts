import * as assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import { describe, it } from "node:test";
import { OWN_PACKAGE } from "./helpers/own-package";
import { addressOf } from "./helpers/net";
import {
  runCli,
  BACKEND_URL,
  SESSION_SECRET,
  workspaceDir,
  PRODUCTION_WORKSPACE,
  builtWorkspace,
  listenOnFreePort,
  closeServer,
} from "./fixtures/cli-sandbox.mts";

describe("validating options before any work", () => {
  it("rejects a port outside 0-65535 in dev and start", async () => {
    for (const port of ["abc", "-1", "70000"]) {
      const dev = await runCli(["dev", "-b", BACKEND_URL, "-p", port]);
      assert.equal(dev.code, 2, `dev -p ${port}`);
      assert.equal(dev.stdout, "");
      assert.match(dev.stderr, new RegExp(`^✖ Invalid port '${port}'\n`));
      assert.match(dev.stderr, /→ Pass a number between 1 and 65535, or 0 for/);
      assert.doesNotMatch(dev.stderr, /No free port|Setting up workspace/);

      const start = await runCli(["start", "-b", BACKEND_URL, "-p", port], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(start.code, 2, `start -p ${port}`);
      assert.match(start.stderr, new RegExp(`^✖ Invalid port '${port}'\n`));
      assert.doesNotMatch(start.stderr, /Starting production server/);
    }
  });

  it("reports the dev port fallback only once the setup succeeded", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      const result = await runCli([
        "dev",
        "-b",
        "http://127.0.0.1:9",
        "-p",
        `${port}`,
      ]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /✖ Cannot reach the DMS backend/);
      assert.doesNotMatch(result.stderr, /Setup failed|is busy, using/);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a backend URL without an http or https scheme", async () => {
    for (const command of ["dev", "start", "clean"]) {
      const result = await runCli([command, "-b", "localhost:5010"], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(result.code, 2, command);
      assert.match(result.stderr, /^✖ Invalid backend URL 'localhost:5010'\n/);
      assert.match(
        result.stderr,
        /→ Include the scheme: -b http:\/\/localhost:5010/,
      );
      assert.doesNotMatch(result.stderr, /fetch failed|ajs dms /);
    }
  });

  it("fails prepare for an invalid backend URL without failing the install", async () => {
    const result = await runCli(["prepare", "-b", "localhost:5010"]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /▲ Prepare failed: Invalid backend URL/);

    const strict = await runCli([
      "prepare",
      "-b",
      "localhost:5010",
      "--strict",
    ]);
    assert.equal(strict.code, 2);
    assert.match(strict.stderr, /^✖ Invalid backend URL 'localhost:5010'\n/);
  });

  it("names the character that keeps the bootstrap credential out of a header", async () => {
    const result = await runCli(["dev", "-b", BACKEND_URL], {
      env: { DMS_BOOTSTRAP_SECRET: "abc def" },
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✖ The bootstrap credential cannot travel in an HTTP header\n/,
    );
    assert.match(result.stderr, /DMS_BOOTSTRAP_SECRET contains a space\./);
    assert.doesNotMatch(result.stderr, /Error:|contains a line break|abc def/);
  });

  it("stops start on a busy port before spawning the server", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      const result = await runCli(
        ["start", "-b", BACKEND_URL, "-p", `${port}`],
        {
          files: builtWorkspace(),
          env: { DMS_SESSION_SECRET: SESSION_SECRET },
        },
      );
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        new RegExp(`✖ Port ${port} is already in use`),
      );
      assert.match(result.stderr, /→ .*another port: -p <port>/);
      assert.doesNotMatch(result.stderr, /server ready|EADDRINUSE/);
    } finally {
      await closeServer(server);
    }
  });

  it("reports a server that could not listen as a failure with a fix", async () => {
    const dir = PRODUCTION_WORKSPACE;
    const result = await runCli(["start", "-b", BACKEND_URL, "-p", "0"], {
      files: {
        ...builtWorkspace(),
        [join(dir, "server.mjs")]:
          'process.send({ type: "dms:listen-error", code: "EADDRINUSE", ' +
          'message: "listen EADDRINUSE", host: "0.0.0.0", port: 3331 }, ' +
          "() => process.exit(1));\n",
      },
      env: { DMS_SESSION_SECRET: SESSION_SECRET },
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /✖ Port 3331 is already in use\n {2}Another process is listening on 0\.0\.0\.0:3331\.\n {2}→ Stop it, or pass another port: -p <port>\n/,
    );
    assert.doesNotMatch(result.stderr, /server ready|Stopped/);
  });

  it("opens start with the backend, the mode and the build's age", async () => {
    const result = await runCli(["start", "-b", BACKEND_URL, "-p", "0"], {
      files: builtWorkspace(),
      env: { DMS_SESSION_SECRET: SESSION_SECRET },
    });
    assert.equal(result.code, 0);
    assert.match(
      result.stderr,
      new RegExp(
        `^ajs dms start {2}${BACKEND_URL.replaceAll(".", "\\.")} · production · built just now\n`,
      ),
    );
  });

  it("hands a free port over to the production server", async () => {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    const result = await runCli(["start", "-b", BACKEND_URL, "-p", `${port}`], {
      files: builtWorkspace(),
      env: { DMS_SESSION_SECRET: SESSION_SECRET },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `server port ${port}\n`);
  });

  it("reports the modules the build serves, and warns when the project now gives others", async () => {
    let report: unknown;
    const backend = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        if (request.url === "/dms/frontend/ready") report = JSON.parse(body);
        response.end(request.url === "/reported" ? String(!!report) : "{}");
      });
    });
    await new Promise<void>((resolve) => backend.listen(0, resolve));
    const backendUrl = `http://127.0.0.1:${addressOf(backend).port}`;
    try {
      const result = await runCli(["start", "-b", backendUrl, "-p", "0"], {
        files: {
          ...builtWorkspace(),
          "antelope.config.ts":
            "export default { name: 'sandbox', modules: { builder: " +
            "{ source: { type: 'local', path: './builder' }, " +
            "config: { enabled: process.env.BUILDER_ENABLED === '1' } } } };\n",
          "builder/package.json": JSON.stringify({
            name: "demo-builder",
            version: "2.0.0",
            dmsFrontend: "frontend.cjs",
          }),
          "builder/frontend.cjs":
            "exports.frontendModule = (config) => config.enabled ? " +
            "{ name: 'demo-builder', sourcePath: __dirname + '/frontend-vue', " +
            "renderer: { name: 'vue', version: '3' } } : undefined;\n",
          [join(PRODUCTION_WORKSPACE, "generated-frontend-modules.json")]:
            JSON.stringify({
              modules: [
                { id: "demo-lang", name: "demo-lang", version: "1.4.0" },
              ],
            }),
          [join(PRODUCTION_WORKSPACE, "server.mjs")]:
            "process.send({ type: 'dms:ready', address: '127.0.0.1', port: 1 });\n" +
            "const poll = setInterval(async () => {\n" +
            "  const response = await fetch(`${process.env.DMS_API_BASE_URL}/reported`);\n" +
            "  if ((await response.text()) === 'true') { clearInterval(poll); process.exit(0); }\n" +
            "}, 20);\n",
        },
        env: { DMS_SESSION_SECRET: SESSION_SECRET, BUILDER_ENABLED: "1" },
      });
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(report, {
        modules: [{ name: "demo-lang", version: "1.4.0" }],
        version: OWN_PACKAGE.version,
      });
      assert.match(
        result.stderr,
        /▲ The project's modules differ from the ones the build serves: rebuild to apply them\n {2}Not in the build: demo-builder\n {2}Built, no longer in the project: demo-lang\n {2}→ Build again with the deployment's variables: ajs dms build\n/,
      );
    } finally {
      backend.close();
    }
  });

  /** A built workspace whose server prints the NODE_ENV it was given. */
  function nodeEnvWorkspace() {
    return {
      ...builtWorkspace(),
      [join(PRODUCTION_WORKSPACE, "server.mjs")]:
        "console.log(`NODE_ENV ${process.env.NODE_ENV}`);\n",
    };
  }

  it("runs the production server under NODE_ENV=production when it is unset", async () => {
    const result = await runCli(["start", "-b", BACKEND_URL, "-p", "0"], {
      files: nodeEnvWorkspace(),
      env: { DMS_SESSION_SECRET: SESSION_SECRET, NODE_ENV: undefined },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "NODE_ENV production\n");
    assert.doesNotMatch(result.stderr, /NODE_ENV/);
  });

  it("keeps a NODE_ENV the project sets, and warns it is not production", async () => {
    const result = await runCli(["start", "-b", BACKEND_URL, "-p", "0"], {
      files: { ...nodeEnvWorkspace(), ".env": "NODE_ENV=development\n" },
      env: { DMS_SESSION_SECRET: SESSION_SECRET, NODE_ENV: undefined },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "NODE_ENV development\n");
    assert.match(
      result.stderr,
      /▲ NODE_ENV is development: the server renders with the development builds of Vue and its libraries\n {2}→ Unset it for start, or set it to production\n/,
    );
  });

  it("reports clean without a target as a usage error", async () => {
    const result = await runCli(["clean"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✖ Nothing to clean: pass -b <url> or --all\n/,
    );
    assert.doesNotMatch(result.stderr, /▲/);
  });

  it("never takes the clean target from the project's .env", async () => {
    const workspace = workspaceDir(BACKEND_URL);
    const result = await runCli(["clean"], {
      files: {
        ".env": `DMS_API_BASE_URL=${BACKEND_URL}\n`,
        [join(workspace, "server.mjs")]: "",
      },
      env: { DMS_API_BASE_URL: undefined },
    });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /✖ Nothing to clean/);
    assert.match(result.stderr, /never uses DMS_API_BASE_URL/);
    assert.ok(existsSync(join(result.sandbox, workspace)));

    const explicit = await runCli(["clean", "-b", BACKEND_URL], {
      files: { [join(workspace, "server.mjs")]: "" },
    });
    assert.equal(explicit.code, 0);
    assert.match(explicit.stderr, /✔ Removed workspace/);
    assert.ok(!existsSync(join(explicit.sandbox, workspace)));
  });

  it("checks verify-source paths before spawning the runner", async () => {
    const missing = await runCli(["verify-source", "-l", "./nope"]);
    assert.equal(missing.code, 2);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /^✖ Layer path not found: \.\/nope\n/);
    assert.match(missing.stderr, /dms\.frontend\.ts/);
    assert.doesNotMatch(missing.stderr, /ENOENT|Error:|at /);

    const module = await runCli([
      "verify-source",
      "-l",
      ".",
      "-m",
      "./missing-module",
    ]);
    assert.equal(module.code, 2);
    assert.match(module.stderr, /✖ Module path not found: \.\/missing-module/);

    const local = await runCli([
      "verify-source",
      "-l",
      ".",
      "--local-package",
      "foo",
    ]);
    assert.equal(local.code, 2);
    assert.match(local.stderr, /^✖ Invalid local package 'foo'\n/);
    assert.match(local.stderr, /name=path/);
    assert.doesNotMatch(local.stderr, /Error:/);
  });
});
