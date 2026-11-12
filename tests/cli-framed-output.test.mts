import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  FakePnpmCli,
  MODULE,
  projectHome,
  writeLayer,
} from "./fixtures/fake-pnpm-cli.mts";
import { addressOf } from "./helpers/net";

const OFFLINE_BACKEND = "http://127.0.0.1:9";
const GUTTER = /pnpm [│|] /;
/** The symbols that start the only lines a quiet run prints: warnings and errors. */
const QUIET_LINE = /^(?:[▲✖] | {2})/;

/** The lines of `output` that start with anything but a warning or an error. */
function chattyLines(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line !== "" && !QUIET_LINE.test(line));
}

/** A finished task, with the duration a slow machine may add. */
const DONE = "(?: \\S+)?\n";

/** A backend serving a one-module manifest whose source is `layer`. */
function serveManifest(
  layer: string,
): Promise<{ server: Server; url: string }> {
  const manifest = {
    version: 2,
    modules: [{ ...MODULE, path: layer }],
  };
  return new Promise((settle) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = addressOf(server);
      settle({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/**
 * A home holding the manifest a previous dev run cached from `backendUrl`,
 * without the layer source paths a production backend withholds.
 */
function pathlessDevHome(sandbox: string, backendUrl: string): void {
  const workspace = join(
    sandbox,
    ".antelopejs/dms-frontend",
    createHash("sha256").update(backendUrl).digest("hex"),
  );
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, ".manifest-cache.json"),
    JSON.stringify({
      manifest: { modules: [MODULE] },
      fetchedAt: new Date().toISOString(),
    }),
  );
}

const projectBuild = ["build"];

/** The fake pnpm is a shell script, like the one cli-signals puts on PATH. */
const describePosix = process.platform === "win32" ? describe.skip : describe;

let cli: FakePnpmCli;
let layer: string;
let backend: { server: Server; url: string };

function registerInstallAndBuildTests(): void {
  void it("installs as one task and keeps pnpm's own output to itself", async () => {
    const run = await cli.run(["prepare", "-b", backend.url]);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      new RegExp(`✔ Workspace generated${DONE}✔ Installed 3 packages${DONE}`),
    );
    assert.match(
      run.stderr,
      /✔ Prepared the workspace · 1 module · types and registry written · \S+\n {2}\.\/\.antelopejs\/dms-frontend\/[0-9a-f]{64}\n$/,
    );
    assert.doesNotMatch(run.stderr, /Progress:|Scope:|DEP0169/);
    const [install] = run.calls;
    assert.deepEqual(install.args, ["install", "--reporter=append-only"]);
    assert.equal(install.env.updateNotifier, "false");
  });

  void it("replays the end of a failed install, with paths at their source", async () => {
    const run = await cli.run(["dev", "-b", backend.url, "-p", "0"], {
      setUp: projectHome,
      scenario: "install-fails",
    });

    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /✖ Dependency install failed\n {2}pnpm install exited with code 1\.\n/,
    );
    assert.match(run.stderr, /install output line 8\n/);
    assert.doesNotMatch(run.stderr, /install output line 7\n/);
    assert.match(run.stderr, / ERR_PNPM_FETCH_404 /);
    assert.match(run.stderr, /\n {2}\.\/frontend-vue:\n/);
    assert.doesNotMatch(run.stderr, /frontend-modules|DEP0169|Progress:/);
    assert.match(run.stderr, /Run with --verbose for the full output\.\n$/);
  });

  void it("streams everything behind a gutter in a verbose run", async () => {
    const run = await cli.run(
      ["dev", "-b", backend.url, "-p", "0", "--verbose"],
      { setUp: projectHome, scenario: "install-fails" },
    );

    assert.equal(run.code, 1);
    for (const line of ["Scope: all 2", "DEP0169", "install output line 1\n"])
      assert.match(run.stderr, new RegExp(`${GUTTER.source}.*${line}`));
    assert.match(
      run.stderr,
      /pnpm install exited with code 1; its output is above\./,
    );
    assert.doesNotMatch(run.stderr, /Run with --verbose/);
  });

  void it("builds step by step and lists Vite's warnings where logs are read later", async () => {
    const run = await cli.run(projectBuild, { setUp: projectHome });

    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      new RegExp(
        [
          "✔ Built the client bundle",
          "✔ Compressed the client assets",
          "✔ Built the SSR bundle",
          "✔ Built the e-mail bundle",
          "✔ Built the server modules",
        ].join(DONE) +
          `${DONE}▲ 1 Vite warning\n  \\(!\\) Some chunks are larger than 500 kB`,
      ),
    );
    assert.match(
      run.stderr,
      new RegExp(
        [
          "",
          "Built the production frontend → \\./\\.dms-frontend/dist · \\d+(?:ms|\\.\\ds)",
          "",
          "Next steps",
          "  ajs dms start -b <backend>  from the project, with DMS_SESSION_SECRET, the server's secrets and the deployment's variables in its environment",
          "",
        ].join("\n") + "$",
      ),
    );
    const steps = run.calls.slice(1);
    assert.deepEqual(
      steps.map((call) => call.args),
      [
        "build:client",
        "build:compress",
        "build:ssr",
        "build:email",
        "build:server",
      ].map((script) => ["--silent", "run", script]),
    );
    assert.ok(steps.every((call) => call.env.viteLogLevel === "warn"));
  });
}

void describePosix("framing pnpm install and the production build", () => {
  before(async () => {
    cli = new FakePnpmCli("dms-frontend-framed-");
    layer = join(cli.scratch, "layer");
    writeLayer(layer);
    backend = await serveManifest(layer);
  });
  after(async () => {
    await new Promise((settle) => backend.server.close(settle));
    cli.dispose();
  });

  registerInstallAndBuildTests();

  void it("keeps only the warnings of a quiet build", async () => {
    const run = await cli.run([...projectBuild, "-q"], {
      setUp: projectHome,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      /\n▲ 1 Vite warning\n {2}\(!\) Some chunks are larger than 500 kB/,
    );
    assert.deepEqual(chattyLines(run.stderr), []);
    assert.doesNotMatch(run.stderr, /Built the production frontend|\n\n/);
  });

  void it("keeps only the warnings of a quiet prepare", async () => {
    const run = await cli.run(["-q", "prepare", "-b", backend.url]);

    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, "");
    assert.deepEqual(chattyLines(run.stderr), []);
    assert.doesNotMatch(run.stderr, /Prepared the workspace/);
  });

  void it("says the cached manifest has no layer paths when prepare runs offline", async () => {
    const run = await cli.run(
      ["prepare", "-b", OFFLINE_BACKEND, "--offline", "--strict"],
      { setUp: (sandbox) => pathlessDevHome(sandbox, OFFLINE_BACKEND) },
    );

    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /✖ The cached manifest of http:\/\/127\.0\.0\.1:9 \(fetched just now\) has no layer source paths \(1 of 1 module\)\n {2}This run did not fetch it\./,
    );
    assert.doesNotMatch(run.stderr, /this run sent none/);
  });

  void it("ends a build in ASCII on a dumb terminal", async () => {
    const run = await cli.run(projectBuild, {
      setUp: projectHome,
      env: { TERM: "dumb" },
    });

    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      /\nBuilt the production frontend > \.\/\.dms-frontend\/dist - \d+(?:ms|\.\ds)\n/,
    );
    assert.doesNotMatch(run.stderr, /[^\n -~]/);
  });

  void it("reports a Vite error once, at the layer source, without the stack", async () => {
    const run = await cli.run(projectBuild, {
      setUp: projectHome,
      scenario: "ssr-fails",
    });

    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /✖ SSR bundle failed(?: \S+)?\n✖ Vite could not compile \.\/frontend-vue\/app\/components\/Callout\.vue:10:50\n {2}\[vue\/compiler-sfc\] Unexpected token\n {2}10 \|.*\n {5}\| +\^\n {2}Run with --verbose for the full Vite output\.\n {2}→ Fix the file and run ajs dms build again\n$/,
    );
    assert.doesNotMatch(run.stderr, /at constructor|frontend-modules/);
    assert.doesNotMatch(run.stderr, /e-mail bundle/);
  });
});

void describePosix("framing verify-source", () => {
  before(() => {
    cli = new FakePnpmCli("dms-frontend-verify-");
  });
  after(() => cli.dispose());

  /** The DMS core layer, the only one the checks run against. */
  function sourceLayer(sandbox: string): void {
    writeLayer(join(sandbox, "frontend-vue"));
    writeFileSync(
      join(sandbox, "frontend-vue/package.json"),
      JSON.stringify({ name: "@antelopejs/dms-frontend-vue" }),
    );
    writeFileSync(
      join(sandbox, "frontend-vue/dms.frontend.ts"),
      "export default {};\n",
    );
  }

  void it("reports a failed check once, at the layer source, without a stack", async () => {
    const run = await cli.run(["verify-source", "-l", "frontend-vue"], {
      setUp: sourceLayer,
      scenario: "ssr-fails",
    });

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      /^ajs dms verify-source {2}1 module\nℹ Verifying against the DMS core layer in \.\/frontend-vue\n/,
    );
    assert.match(
      run.stderr,
      new RegExp(
        `✔ Materialized 1 module${DONE}✔ Installed 3 packages${DONE}` +
          `✔ Generated the type declarations${DONE}` +
          `(?:✔ .+\n)*` +
          "✖ SSR bundle failed(?: \\S+)?\n" +
          `(?:✔ .+\n)*` +
          "✖ Vite could not compile \\./frontend-vue/app/components/Callout\\.vue:10:50\n" +
          " {2}\\[vue/compiler-sfc\\] Unexpected token\n" +
          " {2}10 \\|.*\n {5}\\| +\\^\n" +
          " {2}Run with --verbose for the full Vite output\\.\n" +
          " {2}→ Fix the file and run ajs dms verify-source again\n$",
      ),
    );
    assert.doesNotMatch(
      run.stderr,
      /^\s+at |frontend-modules|Source verification failed|Generated workspace/m,
    );
    assert.deepEqual(run.calls[0].args, [
      "install",
      "--reporter=append-only",
      "--ignore-scripts",
    ]);
  });

  /** A project whose frontend-vue module runs on the @antelopejs/dms it installs. */
  function project(sandbox: string): void {
    const dms = join(sandbox, "node_modules/@antelopejs/dms");
    sourceLayer(dms);
    sourceLayer(sandbox);
    writeFileSync(
      join(sandbox, "frontend-vue/package.json"),
      JSON.stringify({ name: "demo-frontend-vue" }),
    );
    writeFileSync(
      join(dms, "package.json"),
      JSON.stringify({ name: "@antelopejs/dms", version: "9.9.9" }),
    );
  }

  void it("verifies the project's module on the installed core layer", async () => {
    const run = await cli.run(["verify-source"], {
      setUp: project,
      scenario: "ssr-fails",
    });

    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      new RegExp(
        "^ajs dms verify-source {2}2 modules\n" +
          "ℹ Verifying against @antelopejs/dms 9\\.9\\.9 \\(installed in this project\\)\n" +
          `(?:▲.*\n(?: {2}.*\n)*)?✔ Materialized 2 modules${DONE}`,
      ),
    );
  });

  void it("keeps only the failure of a quiet run", async () => {
    const run = await cli.run(["verify-source", "-l", "frontend-vue", "-q"], {
      setUp: sourceLayer,
      scenario: "ssr-fails",
    });

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      /\n✖ SSR bundle failed(?: \S+)?\n✖ Vite could not compile /,
    );
    assert.deepEqual(chattyLines(run.stderr), []);
  });
});
