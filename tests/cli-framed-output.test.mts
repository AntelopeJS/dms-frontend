import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPOSITORY, "dist/index.js");
const FAKE_PNPM = join(REPOSITORY, "tests/fixtures/fake-pnpm.mjs");
const SESSION_SECRET = "framed-output-test-session-secret-0123";
const OFFLINE_BACKEND = "http://127.0.0.1:9";
const GUTTER = /pnpm [│|] /;
/** A finished task, with the duration a slow machine may add. */
const DONE = "(?: \\S+)?\n";

let scratch: string;
let bin: string;

interface PnpmCall {
  args: string[];
  env: { updateNotifier?: string; viteLogLevel?: string };
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  calls: PnpmCall[];
}

interface RunOptions {
  scenario?: string;
  /** Prepares the sandbox, which is both the cwd and HOME, before the run. */
  setUp?: (sandbox: string) => void;
}

function runCli(args: string[], options: RunOptions = {}): Promise<Run> {
  const sandbox = mkdtempSync(join(scratch, "run-"));
  options.setUp?.(sandbox);
  const log = join(sandbox, "pnpm-calls.jsonl");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: sandbox,
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    DMS_API_BASE_URL: "",
    DMS_SESSION_SECRET: SESSION_SECRET,
    FAKE_PNPM_SCENARIO: options.scenario ?? "success",
    FAKE_PNPM_LOG: log,
  };
  delete env.ANTELOPEJS_VERBOSE;
  delete env.FORCE_COLOR;
  const cli = spawn(process.execPath, [CLI, ...args], {
    cwd: sandbox,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.on("data", (chunk) => (stdout += chunk));
  cli.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((settle) =>
    cli.on("close", (code) => {
      const calls = existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as PnpmCall)
        : [];
      settle({ code, stdout, stderr, calls });
    }),
  );
}

function writeLayer(dir: string): void {
  mkdirSync(join(dir, "app/components"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "framed-layer" }),
  );
  writeFileSync(join(dir, "app/components/Callout.vue"), "<template />\n");
}

const MODULE = {
  name: "framed-layer",
  archiveName: "framed-layer",
  priority: 0,
  renderer: { name: "vue", version: "3" },
};

/** A backend serving a one-module manifest whose source is `layer`. */
function serveManifest(
  layer: string,
): Promise<{ server: Server; url: string }> {
  const manifest = {
    version: 1,
    archive: "/dms/frontend/modules",
    modules: [{ ...MODULE, path: layer }],
  };
  return new Promise((settle) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      settle({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** A URL nothing listens on. */
function closedBackendUrl(): Promise<string> {
  return new Promise((settle) => {
    const server = createServer().listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      server.close(() => settle(`http://127.0.0.1:${address.port}`));
    });
  });
}

/**
 * A home holding the manifest and the layers archive a previous build
 * downloaded from `backendUrl`, so `build --offline` runs without a backend.
 * The manifest names `<sandbox>/frontend-vue` as the layer's source.
 */
function cachedBuildHome(sandbox: string, backendUrl: string): void {
  const workspace = join(
    sandbox,
    ".antelopejs/dms-frontend",
    createHash("sha256").update(backendUrl).digest("hex"),
  );
  const source = join(sandbox, "frontend-vue");
  writeLayer(source);
  writeLayer(join(workspace, ".layers-cache", MODULE.archiveName));
  writeFileSync(
    join(workspace, ".manifest-cache.json"),
    JSON.stringify({
      manifest: {
        pack: "/dms/frontend/modules",
        modules: [{ ...MODULE, path: source }],
      },
      fetchedAt: new Date().toISOString(),
    }),
  );
}

function offlineBuildHome(sandbox: string): void {
  cachedBuildHome(sandbox, OFFLINE_BACKEND);
}

const offlineBuild = ["build", "-b", OFFLINE_BACKEND, "--offline"];

// The fake pnpm is a shell script, like the one cli-signals puts on PATH.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("framing pnpm install and the production build", () => {
  let layer: string;
  let backend: { server: Server; url: string };

  before(async () => {
    assert.ok(existsSync(CLI), `${CLI} is missing: run pnpm build first`);
    scratch = mkdtempSync(join(tmpdir(), "dms-frontend-framed-"));
    bin = join(scratch, "bin");
    mkdirSync(bin);
    const pnpm = join(bin, "pnpm");
    writeFileSync(
      pnpm,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PNPM}" "$@"\n`,
    );
    chmodSync(pnpm, 0o755);
    layer = join(scratch, "layer");
    writeLayer(layer);
    backend = await serveManifest(layer);
  });
  after(async () => {
    await new Promise((settle) => backend.server.close(settle));
    rmSync(scratch, { recursive: true, force: true });
  });

  it("installs as one task and keeps pnpm's own output to itself", async () => {
    const run = await runCli(["prepare", "-b", backend.url]);

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

  it("replays the end of a failed install, with paths at their source", async () => {
    const run = await runCli(["dev", "-b", backend.url, "-p", "0"], {
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
    assert.ok(run.stderr.includes(`  ${layer}:\n`), run.stderr);
    assert.doesNotMatch(run.stderr, /frontend-modules|DEP0169|Progress:/);
    assert.match(run.stderr, /Run with --verbose for the full output\.\n$/);
  });

  it("streams everything behind a gutter in a verbose run", async () => {
    const run = await runCli(
      ["dev", "-b", backend.url, "-p", "0", "--verbose"],
      { scenario: "install-fails" },
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

  it("builds step by step and lists Vite's warnings where logs are read later", async () => {
    const run = await runCli(offlineBuild, { setUp: offlineBuildHome });

    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      new RegExp(
        [
          "✔ Built the client bundle",
          "✔ Compressed the client assets",
          "✔ Built the SSR bundle",
          "✔ Built the e-mail bundle",
        ].join(DONE) +
          `${DONE}▲ 1 Vite warning\n  \\(!\\) Some chunks are larger than 500 kB`,
      ),
    );
    assert.match(
      run.stderr,
      new RegExp(
        [
          "",
          "Built the production frontend → \\./\\.antelopejs/dms-frontend/[0-9a-f]{64}/dist · \\d+(?:ms|\\.\\ds)",
          "",
          "Next steps",
          `  ajs dms start -b ${OFFLINE_BACKEND.replaceAll(".", "\\.")}  with the DMS_SESSION_SECRET this build used`,
          "",
        ].join("\n") + "$",
      ),
    );
    const steps = run.calls.slice(1);
    assert.deepEqual(
      steps.map((call) => call.args),
      ["build:client", "build:compress", "build:ssr", "build:email"].map(
        (script) => ["--silent", "run", script],
      ),
    );
    assert.ok(steps.every((call) => call.env.viteLogLevel === "warn"));
  });

  it("fails when the backend is down instead of building from the cache", async () => {
    const backendUrl = await closedBackendUrl();
    const run = await runCli(["build", "-b", backendUrl], {
      setUp: (sandbox) => cachedBuildHome(sandbox, backendUrl),
    });

    assert.equal(run.code, 1);
    assert.equal(run.stdout, "");
    assert.match(
      run.stderr,
      new RegExp(
        [
          `✖ Cannot reach the DMS backend at ${backendUrl.replaceAll(".", "\\.")}`,
          "  Connection refused \\(ECONNREFUSED\\)\\. A manifest cached just now exists; a build uses it only with --offline\\.",
          "  → Start the backend .*",
          `  → Or build from the cache on purpose: ajs dms build -b ${backendUrl.replaceAll(".", "\\.")} --offline`,
        ].join("\n"),
      ),
    );
    assert.doesNotMatch(run.stderr, /Built|Workspace generated/);
    assert.deepEqual(run.calls, []);
  });

  it("reports a Vite error once, at the layer source, without the stack", async () => {
    const run = await runCli(offlineBuild, {
      setUp: offlineBuildHome,
      scenario: "ssr-fails",
    });

    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /✖ SSR bundle failed(?: \S+)?\n✖ Vite could not compile \.\/frontend-vue\/app\/components\/Callout\.vue:10:50\n {2}\[vue\/compiler-sfc\] Unexpected token\n {2}→ Fix the file and run ajs dms build again\n/,
    );
    assert.match(
      run.stderr,
      /Run with --verbose for the full Vite output\.\n$/,
    );
    assert.doesNotMatch(run.stderr, /at constructor|frontend-modules/);
    assert.doesNotMatch(run.stderr, /e-mail bundle/);
  });
});
