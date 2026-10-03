import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const packageJson = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
);

const cliEntry = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/index.ts",
);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The sandbox, both cwd and HOME of the run. */
  sandbox: string;
}

interface RunCliOptions {
  /** Files written into the sandbox (cwd and HOME) before the CLI starts. */
  files?: Record<string, string>;
  /** Variables layered onto the child environment; undefined removes one. */
  env?: Record<string, string | undefined>;
}

/**
 * Run the CLI the way a user outside any DMS project would: an empty cwd and
 * an empty HOME, so `clean --all` can never reach the real workspaces.
 */
async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const sandbox = mkdtempSync(join(tmpdir(), "dms-cli-"));
  for (const [name, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(sandbox, name)), { recursive: true });
    writeFileSync(join(sandbox, name), content);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox,
    NO_UPDATE_NOTIFIER: "1",
    DMS_API_BASE_URL: "",
    ...options.env,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", import.meta.resolve("tsx"), cliEntry, ...args],
      { cwd: sandbox, env: env as NodeJS.ProcessEnv },
    );
    return { code: 0, stdout, stderr, sandbox };
  } catch (err: any) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      sandbox,
    };
  }
}

describe("running outside a DMS project", () => {
  it("prints help without a project", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /Usage: ajs dms/);
    assert.match(result.stdout, /--no-update-check/);
  });

  it("reports the version without a project", async () => {
    const result = await runCli(["--version"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout.trim(), packageJson.version);
  });

  it("cleans an empty home without a project", async () => {
    const result = await runCli(["clean", "--all"]);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No workspaces found/);
  });

  it("accepts the update-check opt-out anywhere on the command line", async () => {
    const result = await runCli(["clean", "--all", "--no-update-check"]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /No workspaces found/);
  });

  it("names what is missing for a project-bound command", async () => {
    const build = await runCli(["build"]);
    assert.equal(build.code, 1);
    assert.equal(build.stdout, "");
    assert.match(build.stderr, /Backend URL is required.*DMS_API_BASE_URL/);

    const dev = await runCli(["dev"]);
    assert.equal(dev.code, 1);
    assert.equal(dev.stdout, "");
    assert.match(dev.stderr, /no running antelope project found/);
    assert.match(dev.stderr, /-b <url>/);
  });

  it("writes feedback to stderr and leaves stdout empty", async () => {
    const noUrl = await runCli(["prepare"]);
    assert.equal(noUrl.code, 0);
    assert.equal(noUrl.stdout, "");
    assert.match(noUrl.stderr, /⚠ Backend URL not set; skipping prepare/);

    const unreachable = await runCli(["prepare", "-b", "http://127.0.0.1:9"]);
    assert.equal(unreachable.code, 0);
    assert.equal(unreachable.stdout, "");
    assert.match(unreachable.stderr, /Setting up workspace/);
    assert.match(unreachable.stderr, /⚠ Skipping prepare:/);
  });

  it("requires a session secret for build and start", async () => {
    const noSecret = { env: { DMS_SESSION_SECRET: undefined } };
    const build = await runCli(["build", "-b", BACKEND_URL], noSecret);
    assert.equal(build.code, 2);
    assert.equal(build.stdout, "");
    assert.match(build.stderr, /^✗ DMS_SESSION_SECRET is not set\n/);
    assert.match(build.stderr, /→ Create one: openssl rand -hex 32/);
    assert.doesNotMatch(build.stderr, /Error:|at least 32/);

    const start = await runCli(["start", "-b", BACKEND_URL], noSecret);
    assert.equal(start.code, 2);
    assert.match(start.stderr, /✗ DMS_SESSION_SECRET is not set/);

    const short = await runCli(["start", "-b", BACKEND_URL], {
      env: { DMS_SESSION_SECRET: "short" },
    });
    assert.equal(short.code, 2);
    assert.match(
      short.stderr,
      /✗ DMS_SESSION_SECRET is too short: 5 characters, at least 32 needed/,
    );
    assert.match(short.stderr, /openssl rand -hex 32/);

    const dev = await runCli(["dev", "-b", BACKEND_URL], {
      env: { DMS_SESSION_SECRET: "short" },
    });
    assert.equal(dev.code, 2);
    assert.match(dev.stderr, /✗ DMS_SESSION_SECRET is too short/);
    assert.doesNotMatch(dev.stderr, /Setting up workspace/);
  });
});

const BACKEND_URL = "http://127.0.0.1:5010";
const SESSION_SECRET = "configured-session-secret-at-least-32-characters";

/** Sandbox-relative directory of the workspace build and start use. */
function workspaceDir(backendUrl: string): string {
  const hash = createHash("sha256").update(backendUrl).digest("hex");
  return join(".antelopejs", "dms-frontend", hash);
}

/** A built workspace whose server prints the port it was given, then exits. */
function builtWorkspace(backendUrl: string): Record<string, string> {
  const dir = workspaceDir(backendUrl);
  return {
    [join(dir, "server.mjs")]:
      "console.log(`server port ${process.env.PORT}`);\n",
    [join(dir, "dist", "client", "index.html")]: "<!doctype html>\n",
  };
}

function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0 }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("validating options before any work", () => {
  it("rejects a port outside 0-65535 in dev and start", async () => {
    for (const port of ["abc", "-1", "70000"]) {
      const dev = await runCli(["dev", "-b", BACKEND_URL, "-p", port]);
      assert.equal(dev.code, 2, `dev -p ${port}`);
      assert.equal(dev.stdout, "");
      assert.match(dev.stderr, new RegExp(`^✗ Invalid port '${port}'\n`));
      assert.match(dev.stderr, /→ Pass a number between 1 and 65535, or 0 for/);
      assert.doesNotMatch(dev.stderr, /No free port|Setting up workspace/);

      const start = await runCli(["start", "-b", BACKEND_URL, "-p", port], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(start.code, 2, `start -p ${port}`);
      assert.match(start.stderr, new RegExp(`^✗ Invalid port '${port}'\n`));
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
      assert.match(result.stderr, /Setup failed/);
      assert.doesNotMatch(result.stderr, /in use, using/);
    } finally {
      await closeServer(server);
    }
  });

  it("rejects a backend URL without an http or https scheme", async () => {
    for (const command of ["dev", "build", "start", "clean"]) {
      const result = await runCli([command, "-b", "localhost:5010"], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(result.code, 2, command);
      assert.match(result.stderr, /^✗ Invalid backend URL 'localhost:5010'\n/);
      assert.match(
        result.stderr,
        /→ Include the scheme: -b http:\/\/localhost:5010/,
      );
      assert.doesNotMatch(result.stderr, /fetch failed|Setting up workspace/);
    }
  });

  it("skips prepare for an invalid backend URL without failing the install", async () => {
    const result = await runCli(["prepare", "-b", "localhost:5010"]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /Skipping prepare: Invalid backend URL/);
  });

  it("names the character that keeps the bootstrap credential out of a header", async () => {
    const result = await runCli(["dev", "-b", BACKEND_URL], {
      env: { DMS_BOOTSTRAP_SECRET: "abc def" },
    });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✗ The bootstrap credential cannot travel in an HTTP header\n/,
    );
    assert.match(result.stderr, /DMS_BOOTSTRAP_SECRET contains a space\./);
    assert.doesNotMatch(result.stderr, /Error:|contains a line break|abc def/);

    const build = await runCli(["build", "-b", BACKEND_URL], {
      env: {
        DMS_BOOTSTRAP_SECRET: "abc def",
        DMS_SESSION_SECRET: SESSION_SECRET,
      },
    });
    assert.equal(build.code, 2);
    assert.doesNotMatch(build.stderr, /Setup failed|Setting up workspace/);
  });

  it("stops start on a busy port before spawning the server", async () => {
    const { server, port } = await listenOnFreePort();
    try {
      const result = await runCli(
        ["start", "-b", BACKEND_URL, "-p", `${port}`],
        {
          files: builtWorkspace(BACKEND_URL),
          env: { DMS_SESSION_SECRET: SESSION_SECRET },
        },
      );
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.match(
        result.stderr,
        new RegExp(`✗ Port ${port} is already in use`),
      );
      assert.match(result.stderr, /→ .*another port: -p <port>/);
      assert.doesNotMatch(
        result.stderr,
        /Starting production server|EADDRINUSE/,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("hands a free port over to the production server", async () => {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    const result = await runCli(["start", "-b", BACKEND_URL, "-p", `${port}`], {
      files: builtWorkspace(BACKEND_URL),
      env: { DMS_SESSION_SECRET: SESSION_SECRET },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, `server port ${port}\n`);
  });

  it("reports clean without a target as a usage error", async () => {
    const result = await runCli(["clean"]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✗ Nothing to clean: pass -b <url> or --all\n/,
    );
    assert.doesNotMatch(result.stderr, /⚠/);
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
    assert.match(result.stderr, /✗ Nothing to clean/);
    assert.match(result.stderr, /never uses DMS_API_BASE_URL/);
    assert.ok(existsSync(join(result.sandbox, workspace)));

    const explicit = await runCli(["clean", "-b", BACKEND_URL], {
      files: { [join(workspace, "server.mjs")]: "" },
    });
    assert.equal(explicit.code, 0);
    assert.match(explicit.stderr, /✓ Removed workspace/);
    assert.ok(!existsSync(join(explicit.sandbox, workspace)));
  });

  it("checks verify-source paths before spawning the runner", async () => {
    const missing = await runCli(["verify-source", "-l", "./nope"]);
    assert.equal(missing.code, 2);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /^✗ Layer path not found: \.\/nope\n/);
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
    assert.match(module.stderr, /✗ Module path not found: \.\/missing-module/);

    const local = await runCli([
      "verify-source",
      "-l",
      ".",
      "--local-package",
      "foo",
    ]);
    assert.equal(local.code, 2);
    assert.match(local.stderr, /^✗ Invalid local package 'foo'\n/);
    assert.match(local.stderr, /name=path/);
    assert.doesNotMatch(local.stderr, /Error:/);
  });
});

describe("explaining an unreachable backend", () => {
  async function closedBackendUrl(): Promise<string> {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    return `http://127.0.0.1:${port}`;
  }

  it("names the URL and the cause in dev, build and prepare", async () => {
    const backendUrl = await closedBackendUrl();
    for (const command of ["dev", "build", "prepare"]) {
      const result = await runCli([command, "-b", backendUrl], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(result.code, command === "prepare" ? 0 : 1, command);
      assert.match(
        result.stderr,
        new RegExp(
          `(Setup failed|Skipping prepare): Cannot reach the DMS backend at ${backendUrl}\n`,
        ),
        command,
      );
      assert.match(result.stderr, /Connection refused \(ECONNREFUSED\)\./);
      assert.match(result.stderr, /→ Start the backend/);
      assert.doesNotMatch(result.stderr, /fetch failed/);
    }
  });
});

/**
 * `start` is the cheapest command that proves a variable reached Commander:
 * it needs only a backend URL, touches no network, and names the URL it
 * resolved in the "build first" hint it prints when the workspace is absent.
 */
describe("loading the project .env", () => {
  const ENV_ONLY = {
    DMS_API_BASE_URL: undefined,
    DMS_SESSION_SECRET: "configured-session-secret-at-least-32-characters",
  };

  it("fills a variable the environment does not define", async () => {
    const result = await runCli(["start"], {
      files: { ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n" },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /Backend URL is required/);
    assert.match(result.stderr, /Production build not found/);
    assert.match(result.stderr, /build -b http:\/\/127\.0\.0\.1:5010/);
  });

  it("lets a real environment variable win over the .env", async () => {
    const result = await runCli(["start"], {
      files: { ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n" },
      env: {
        DMS_API_BASE_URL: "http://127.0.0.1:5999",
        DMS_SESSION_SECRET: ENV_ONLY.DMS_SESSION_SECRET,
      },
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /build -b http:\/\/127\.0\.0\.1:5999/);
    assert.doesNotMatch(result.stderr, /5010/);
  });

  it("lets .env.local win over .env", async () => {
    const result = await runCli(["start"], {
      files: {
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
        ".env.local": "DMS_API_BASE_URL=http://127.0.0.1:5011\n",
      },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /build -b http:\/\/127\.0\.0\.1:5011/);
  });

  it("runs normally in a directory with no .env", async () => {
    const result = await runCli(["start"], { env: ENV_ONLY });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /Backend URL is required/);
  });

  it("documents the .env contract in the help epilogue", async () => {
    const result = await runCli(["--help"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /\.env\.local then \.env/);
    assert.match(result.stdout, /already\s+set in the environment always wins/);
  });
});
