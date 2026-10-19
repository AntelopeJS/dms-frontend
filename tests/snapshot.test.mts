// A build that ships with its project: `snapshot` keeps what the build needs
// from the backend, `build --from` makes it without the backend or any
// secret, and `start --workspace` serves it from a read-only directory with
// the secrets of its environment.
import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { storedZip } from "./fixtures/stored-zip.mts";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPOSITORY, "dist/index.js");
const FAKE_PNPM = join(REPOSITORY, "tests/fixtures/fake-pnpm.mjs");
const BOOTSTRAP = "snapshot-test-bootstrap-credential";
const HTML_SECRET = "snapshot-test-html-render-secret";
const RELAY_SECRET = "snapshot-test-oauth-relay-secret";
const SESSION_SECRET = "snapshot-test-session-secret-0123456789";
const DEPLOYED_HTML_SECRET = "deployment-html-render-secret";
const ARCHIVE = "/dms/frontend/modules";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

let scratch: string;
let bin: string;
let backend: { server: Server; url: string };
let requests: string[] = [];
let priority = 0;

function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = scratch,
): Promise<Run> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: scratch,
    NO_COLOR: "1",
    NO_UPDATE_NOTIFIER: "1",
    NODE_OPTIONS: "--no-deprecation",
    FAKE_PNPM_LOG: join(scratch, "pnpm-calls.jsonl"),
    ...env,
  };
  for (const name of [
    "DMS_API_BASE_URL",
    "DMS_BOOTSTRAP_SECRET",
    "DMS_SESSION_SECRET",
    "DMS_HTML_RENDER_SECRET",
    "DMS_OAUTH_RELAY_SECRET",
    "DMS_WORKSPACE_DIR",
  ])
    if (!(name in env)) delete environment[name];
  const cli = spawn(process.execPath, [CLI, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: environment,
  });
  let stdout = "";
  let stderr = "";
  cli.stdout.on("data", (chunk) => (stdout += chunk));
  cli.stderr.on("data", (chunk) => (stderr += chunk));
  return new Promise((settle) =>
    cli.on("close", (code) => settle({ code, stdout, stderr })),
  );
}

/** The manifest the backend serves, its private options included. */
function manifest() {
  return {
    version: 1,
    archive: ARCHIVE,
    modules: [
      {
        name: "@antelopejs/dms-frontend-vue",
        archiveName: "dms-frontend-vue",
        priority,
        renderer: { name: "vue", version: "3" },
        privateOptions: {
          htmlRender: { serviceSecret: HTML_SECRET },
          oauth: { relaySecret: RELAY_SECRET },
        },
        backendProxies: [{ path: "/api/**", auth: "session" }],
      },
    ],
  };
}

/** A backend that serves its manifest and archive to the credential only. */
function serveBackend(): Promise<{ server: Server; url: string }> {
  const archive = storedZip({
    "dms-frontend-vue/package.json": JSON.stringify({
      name: "@antelopejs/dms-frontend-vue",
    }),
    "dms-frontend-vue/app/components/Callout.vue": "<template />\n",
  });
  return new Promise((settle) => {
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      if (req.headers["x-dms-bootstrap"] !== BOOTSTRAP) {
        res.statusCode = 401;
        res.end();
        return;
      }
      if (req.url?.startsWith(ARCHIVE)) {
        res.setHeader("content-type", "application/zip");
        res.end(archive);
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest()));
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      settle({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The files under `dir` that contain one of `values`. */
function filesHolding(dir: string, values: string[]): string[] {
  return filesUnder(dir).filter((file) => {
    const content = readFileSync(join(dir, file), "utf8");
    return values.some((value) => content.includes(value));
  });
}

describe("a build that ships with its project", () => {
  before(async () => {
    assert.ok(existsSync(CLI), `${CLI} is missing: run pnpm build first`);
    scratch = mkdtempSync(join(tmpdir(), "dms-frontend-snapshot-"));
    bin = join(scratch, "bin");
    mkdirSync(bin);
    const pnpm = join(bin, "pnpm");
    writeFileSync(
      pnpm,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PNPM}" "$@"\n`,
    );
    chmodSync(pnpm, 0o755);
    backend = await serveBackend();
  });
  after(async () => {
    await new Promise((settle) => backend.server.close(settle));
    chmodSync(join(scratch, "project"), 0o755);
    rmSync(scratch, { recursive: true, force: true });
  });

  it("builds from a snapshot without the backend or any secret, and keeps none", async () => {
    const project = join(scratch, "project");
    mkdirSync(project);
    const taken = await runCli(
      ["snapshot", "-b", backend.url, "-o", "dms-snapshot"],
      { DMS_BOOTSTRAP_SECRET: BOOTSTRAP },
      project,
    );
    assert.equal(taken.code, 0, taken.stderr);
    const snapshotDir = join(project, "dms-snapshot");
    const snapshot = JSON.parse(
      readFileSync(join(snapshotDir, "snapshot.json"), "utf8"),
    );
    assert.deepEqual(snapshot.manifest.modules[0].privateOptions, {
      htmlRender: { serviceSecret: "" },
      oauth: { relaySecret: "" },
    });
    assert.deepEqual(snapshot.manifest.modules[0].backendProxies, [
      { path: "/api/**", auth: "session" },
    ]);
    assert.deepEqual(filesUnder(join(snapshotDir, "layers")), [
      "dms-frontend-vue/app/components/Callout.vue",
      "dms-frontend-vue/package.json",
    ]);

    requests = [];
    const failed = await runCli(
      ["build", "--from", "dms-snapshot", "--workspace", ".dms-frontend"],
      { FAKE_PNPM_SCENARIO: "ssr-fails" },
      project,
    );
    assert.notEqual(failed.code, 0);
    assert.ok(
      !existsSync(join(project, ".dms-frontend", ".build-origin.json")),
      "a failed build recorded what it was made from",
    );
    const built = await runCli(
      ["build", "--from", "dms-snapshot", "--workspace", ".dms-frontend"],
      {},
      project,
    );
    assert.equal(built.code, 0, built.stderr);
    assert.deepEqual(requests, [], "the build asked the backend");

    const workspace = join(project, ".dms-frontend");
    assert.deepEqual(
      filesHolding(project, [HTML_SECRET, RELAY_SECRET, BOOTSTRAP]),
      [],
    );
    const serverOptions = join(workspace, "generated-server-options.json");
    assert.equal(statSync(serverOptions).mode & 0o777, 0o644);
    assert.deepEqual(JSON.parse(readFileSync(serverOptions, "utf8")).modules, {
      "antelopejs__dms-frontend-vue": {
        htmlRender: { serviceSecret: "" },
        oauth: { relaySecret: "" },
      },
    });
    const origin = JSON.parse(
      readFileSync(join(workspace, ".build-origin.json"), "utf8"),
    );
    assert.equal(origin.digest, snapshot.digest);
    assert.equal(origin.authenticated, true);
  });

  it("serves the build read-only with its environment's secrets, and says when the backend moved on", async () => {
    const project = join(scratch, "project");
    const workspace = join(project, ".dms-frontend");
    // The real server needs the real build; this one reports what it got.
    mkdirSync(join(workspace, "dist", "client"), { recursive: true });
    writeFileSync(join(workspace, "dist", "client", "index.html"), "");
    writeFileSync(
      join(workspace, "server.mjs"),
      'process.send({ type: "dms:ready", address: "127.0.0.1", port: 3321 });\n' +
        "console.log(JSON.stringify({ secret: process.env.DMS_HTML_RENDER_SECRET }));\n" +
        "setTimeout(() => process.exit(0), 1500);\n",
    );
    const before = filesUnder(workspace);
    chmodSync(project, 0o555);
    for (const file of before) chmodSync(join(workspace, file), 0o444);
    chmodSync(workspace, 0o555);
    priority = 7;

    const started = await runCli(
      ["start", "--workspace", ".dms-frontend", "-b", backend.url],
      {
        PORT: "0",
        DMS_SESSION_SECRET: SESSION_SECRET,
        DMS_BOOTSTRAP_SECRET: BOOTSTRAP,
        DMS_HTML_RENDER_SECRET: DEPLOYED_HTML_SECRET,
      },
      project,
    );

    chmodSync(workspace, 0o755);
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual(JSON.parse(started.stdout), {
      secret: DEPLOYED_HTML_SECRET,
    });
    assert.deepEqual(filesUnder(workspace), before);
    assert.match(
      started.stderr,
      /▲ The backend serves modules [0-9a-f]{16}; this build was made from [0-9a-f]{16} \(snapshot/,
    );
    assert.match(
      started.stderr,
      /→ Refresh the snapshot and rebuild: ajs dms snapshot -b /,
    );
  });
});
