import * as assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { listNames } from "./helpers/files";
import { OWN_PACKAGE } from "./helpers/own-package";
import { addressOf, boundAddress } from "./helpers/net";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const builtEntry = join(repository, "dist/index.js");
/**
 * The CLI the runs spawn. CI builds before testing and sets DMS_PREBUILT, so
 * the runs take the compiled CLI, which starts several times faster than the
 * sources under tsx. Elsewhere `dist/` may be stale: the runs take the
 * sources.
 */
const cliCommand =
  process.env.DMS_PREBUILT && existsSync(builtEntry)
    ? [builtEntry]
    : [
        "--import",
        import.meta.resolve("tsx"),
        join(repository, "src/index.ts"),
      ];

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
  /** Whether stderr reads as a terminal, as in an interactive run. */
  isTerminal?: boolean;
}

const TERMINAL_STDERR = import.meta.resolve("./fixtures/terminal-stderr.mjs");

/**
 * Run the CLI the way a user outside any DMS project would: an empty cwd and
 * an empty home (HOME, and USERPROFILE, which Windows reads it from), so
 * `clean --all` can never reach the real workspaces.
 */
async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const sandbox = temporaryDirectory("dms-cli-");
  for (const [name, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(sandbox, name)), { recursive: true });
    writeFileSync(join(sandbox, name), content);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    NO_UPDATE_NOTIFIER: "1",
    DMS_API_BASE_URL: "",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_ALL: undefined,
    LC_CTYPE: undefined,
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
    ANTELOPEJS_VERBOSE: undefined,
    ANTELOPEJS_QUIET: undefined,
    ...options.env,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        ...(options.isTerminal ? ["--import", TERMINAL_STDERR] : []),
        ...cliCommand,
        ...args,
      ],
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
    assert.equal(result.stdout.trim(), OWN_PACKAGE.version);
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
    assert.match(
      build.stderr,
      /✖ Could not evaluate the project's configuration in \S+\n/,
    );
    assert.match(
      build.stderr,
      /→ Run from the project root, or pass --project <dir>\n/,
    );

    const dev = await runCli(["dev"]);
    assert.equal(dev.code, 1);
    assert.equal(dev.stdout, "");
    assert.match(
      dev.stderr,
      /^✖ No backend URL provided and no running antelope project found\n/,
    );
    assert.match(dev.stderr, /→ Or pass the backend explicitly with -b <url>/);
  });

  it("writes feedback to stderr and leaves stdout empty", async () => {
    const noUrl = await runCli(["prepare"]);
    assert.equal(noUrl.code, 0);
    assert.equal(noUrl.stdout, "");
    assert.match(noUrl.stderr, /^▲ Skipped prepare: no backend URL\n/);

    const unreachable = await runCli(["prepare", "-b", "http://127.0.0.1:9"]);
    assert.equal(unreachable.code, 0);
    assert.equal(unreachable.stdout, "");
    assert.match(
      unreachable.stderr,
      /^ajs dms prepare {2}http:\/\/127\.0\.0\.1:9\n/,
    );
    assert.match(unreachable.stderr, /▲ Skipped prepare:/);
  });

  it("requires a session secret to start, and none to build", async () => {
    const noSecret = { env: { DMS_SESSION_SECRET: undefined } };
    const build = await runCli(["build"], noSecret);
    assert.notEqual(build.code, 2);
    assert.doesNotMatch(build.stderr, /DMS_SESSION_SECRET/);

    const start = await runCli(["start", "-b", BACKEND_URL], noSecret);
    assert.equal(start.code, 2);
    assert.equal(start.stdout, "");
    assert.match(start.stderr, /^✖ DMS_SESSION_SECRET is not set\n/);
    assert.match(start.stderr, /→ Create one: openssl rand -hex 32/);
    assert.doesNotMatch(start.stderr, /Error:|at least 32/);

    const short = await runCli(["start", "-b", BACKEND_URL], {
      env: { DMS_SESSION_SECRET: "short" },
    });
    assert.equal(short.code, 2);
    assert.match(
      short.stderr,
      /✖ DMS_SESSION_SECRET is too short: 5 characters, at least 32 needed/,
    );
    assert.match(short.stderr, /openssl rand -hex 32/);

    const dev = await runCli(["dev", "-b", BACKEND_URL], {
      env: { DMS_SESSION_SECRET: "short" },
    });
    assert.equal(dev.code, 2);
    assert.match(dev.stderr, /✖ DMS_SESSION_SECRET is too short/);
    assert.doesNotMatch(dev.stderr, /ajs dms dev|workspace/i);
  });
});

describe("following the ajs output contract", () => {
  it("prints the help on stdout and exits 0 when given no command", async () => {
    for (const args of [[], ["--no-color"], ["--no-update-check"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 0, args.join(" "));
      assert.match(
        result.stdout,
        new RegExp(
          `^ajs dms ${OWN_PACKAGE.version} · DMS frontend for AntelopeJS \\(Vue 3, Vite, Inertia\\)\n\nUsage: ajs dms \\[options\\] \\[command\\]\n`,
        ),
      );
      assert.equal(result.stderr, "");
    }
  });

  it("reports usage errors with the core template and exit code 2", async () => {
    const option = await runCli(["build", "--minify"]);
    assert.equal(option.code, 2);
    assert.equal(option.stdout, "");
    assert.equal(
      option.stderr,
      "✖ Unknown option '--minify'\n" +
        "  Usage: ajs dms build [options]\n" +
        "  → Run ajs dms build --help for usage\n",
    );

    const command = await runCli(["biuld"]);
    assert.equal(command.code, 2);
    assert.match(command.stderr, /^✖ Unknown command 'biuld'\n/);
    assert.match(command.stderr, /→ Did you mean build\?/);

    const help = await runCli(["help", "biuld"]);
    assert.equal(help.code, 2);
    assert.equal(help.stdout, "");
    assert.equal(
      help.stderr,
      "✖ Unknown command 'biuld'\n" +
        "  Usage: ajs dms [options] [command]\n" +
        "  → Run ajs dms --help for usage\n",
    );

    const nothing = await runCli(["verify-source"]);
    assert.equal(nothing.code, 2);
    assert.match(nothing.stderr, /^✖ No frontend module to verify\n/);
  });

  it("reports every problem with verify-source's options at once", async () => {
    const result = await runCli([
      "verify-source",
      "-l",
      "./nope",
      "--local-package",
      "foo",
    ]);
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "✖ Layer path not found: ./nope\n" +
        "  → Pass the root of a DMS frontend package (it contains dms.frontend.ts)\n" +
        "✖ Invalid local package 'foo'\n" +
        "  → Pass it as name=path: --local-package @scope/package=../package\n",
    );

    const missing = await runCli(["verify-source", "--local-package", "foo"]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /^✖ Invalid local package 'foo'\n/);
  });

  it("exits quietly when the reader of its output goes away", async () => {
    const cli = spawn(process.execPath, [...cliCommand, "help", "dev"], {
      cwd: temporaryDirectory("dms-cli-"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
    });
    cli.stdout.destroy();
    let stderr = "";
    cli.stderr.on("data", (chunk) => (stderr += chunk));
    const code = await new Promise((settle) => cli.on("close", settle));
    assert.equal(code, 0);
    assert.equal(stderr, "");
  });

  it("accepts the global options of ajs after a command", async () => {
    for (const flag of ["--no-color", "--verbose"]) {
      const result = await runCli(["clean", "--all", flag]);
      assert.equal(result.code, 0, flag);
      assert.match(result.stderr, /No workspaces found/, flag);
    }
  });

  it("colors feedback only when allowed, and --no-color and NO_COLOR win", async () => {
    const forced = await runCli(["clean"], { env: { FORCE_COLOR: "1" } });
    assert.ok(
      forced.stderr.startsWith(`${ESC}[31m✖${ESC}[39m Nothing to clean`),
      forced.stderr,
    );

    const runs = [
      await runCli(["clean"]),
      await runCli(["clean", "--no-color"], { env: { FORCE_COLOR: "1" } }),
      await runCli(["clean"], { env: { FORCE_COLOR: "1", NO_COLOR: "1" } }),
    ];
    for (const result of runs) {
      assert.equal(result.code, 2);
      assert.ok(!result.stderr.includes(ESC), result.stderr);
    }
  });

  it("falls back to ASCII symbols on a dumb terminal", async () => {
    const result = await runCli(["clean"], { env: { TERM: "dumb" } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /^x Nothing to clean/);
    assert.match(result.stderr, /\n {2}> Remove every workspace/);
    assert.doesNotMatch(result.stderr, /[✖→▲✔ℹ]/);

    const build = await runCli(["build"], {
      env: { TERM: "dumb", DMS_SESSION_SECRET: SESSION_SECRET },
    });
    assert.equal(build.code, 1);
    assert.match(build.stderr, /^ajs dms build {2}\. - production\n/);
    assert.doesNotMatch(build.stderr, /[^\n -~]/);
  });

  it("shows the cause's stack trace only in a verbose run", async () => {
    const quiet = await runCli(["build"], {
      env: { DMS_SESSION_SECRET: SESSION_SECRET },
    });
    assert.equal(quiet.code, 1);
    assert.doesNotMatch(quiet.stderr, /^\s+at /m);
    assert.match(quiet.stderr, /Run with --verbose for the full trace/);

    for (const verbose of [
      { args: ["build", "--verbose"], env: {} },
      { args: ["build", "--verbose=cli"], env: {} },
      { args: ["--verbose=cli,fetch", "build"], env: {} },
      { args: ["--verbose", "build"], env: {} },
      { args: ["build"], env: { ANTELOPEJS_VERBOSE: "*" } },
      { args: ["build"], env: { ANTELOPEJS_VERBOSE: "cli" } },
    ]) {
      const result = await runCli(verbose.args, {
        env: { DMS_SESSION_SECRET: SESSION_SECRET, ...verbose.env },
      });
      assert.equal(result.code, 1, verbose.args.join(" "));
      assert.match(result.stderr, /^\s+at /m, verbose.args.join(" "));
    }
  });
});

const BACKEND_URL = "http://127.0.0.1:5010";

/** Starts every ANSI color sequence. */
const ESC = "\x1b";
const SESSION_SECRET = "configured-session-secret-at-least-32-characters";

/** Sandbox-relative directory of the workspace build and start use. */
function workspaceDir(backendUrl: string): string {
  const hash = createHash("sha256").update(backendUrl).digest("hex");
  return join(".antelopejs", "dms-frontend", hash);
}

/** Sandbox-relative directory a project's production build goes to. */
const PRODUCTION_WORKSPACE = ".dms-frontend";

/**
 * A project without frontend modules, built: its server prints the port it
 * was given, then exits.
 */
function builtWorkspace(): Record<string, string> {
  return {
    "antelope.config.ts": 'export default { name: "sandbox", modules: {} };\n',
    [join(PRODUCTION_WORKSPACE, "server.mjs")]:
      "console.log(`server port ${process.env.PORT}`);\n",
    [join(PRODUCTION_WORKSPACE, "dist", "client", "index.html")]:
      "<!doctype html>\n",
  };
}

function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0 }, () => {
      const address = boundAddress(server);
      if (address === undefined) {
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

const COMMANDS = [
  "dev",
  "build",
  "start",
  "prepare",
  "workspaces",
  "clean",
  "verify-source",
];
const HELP_WIDTH = 80;

describe("documenting the commands", () => {
  it("lists one-line summaries, examples and the environment topic", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /\n {2}build {18}Build the production frontend\n/,
    );
    assert.doesNotMatch(result.stdout, /\[options\]\s{2,}/);
    assert.doesNotMatch(result.stdout, /React|Environment:|Workspaces:/);
    assert.match(result.stdout, /\nExamples:\n {2}# .+\n {2}\$ ajs dms dev\n/);
    assert.match(result.stdout, /ajs dms help environment for the variables/);
  });

  it("gives every command examples, within 80 columns", async () => {
    for (const command of ["", ...COMMANDS]) {
      const result = await runCli(command ? [command, "--help"] : ["--help"]);
      assert.equal(result.code, 0, command);
      if (command) {
        assert.match(
          result.stdout,
          new RegExp(`\nExamples:\n {2}# .+\n {2}\\$ ajs dms ${command}\\b`),
          command,
        );
      }
      assert.match(result.stdout, / {2}-h, --help +Show help for a command\n/);
      for (const line of result.stdout.split("\n")) {
        assert.ok(line.length <= HELP_WIDTH, `${command}: ${line}`);
      }
      assert.doesNotMatch(result.stdout, /\(default: (\[\]|false)\)/, command);
      assert.doesNotMatch(result.stdout, /env: (\w+)[\s\S]*env: \1\b/, command);
    }
  });

  it("describes -b as each command uses it", async () => {
    const help = async (command: string) =>
      (await runCli([command, "--help"])).stdout.replace(/\s+/g, " ");
    assert.match(
      await help("dev"),
      /-b, --backend-url <url> Backend URL; when omitted, discovered from the enclosing antelope project's \.antelope\/dev\.json \(env: DMS_API_BASE_URL\)/,
    );
    const start = await help("start");
    assert.match(start, /-b, --backend-url <url> Backend URL[^(]*; required/);
    assert.doesNotMatch(start, /discover/);
    assert.doesNotMatch(await help("build"), /--backend-url/);
    const clean = await help("clean");
    assert.match(
      clean,
      /Backend URL whose workspace to remove; DMS_API_BASE_URL is never read/,
    );
    assert.doesNotMatch(clean, /env: DMS_API_BASE_URL/);
    assert.match(
      await help("verify-source"),
      /-l, --layer <path> Root of an unpublished DMS core layer to verify instead of the installed one -m/,
    );
  });

  it("prints the environment topic on stdout", async () => {
    for (const args of [
      ["help", "environment"],
      ["--no-color", "help", "environment"],
    ]) {
      const result = await runCli(args);
      assert.equal(result.code, 0, args.join(" "));
      assert.equal(result.stderr, "");
      assert.match(
        result.stdout,
        /^Environment \(read from the shell, then \.\/\.env\.local, then \.\/\.env\)\n\n {2}DMS_API_BASE_URL {14}Backend URL, same as -b; clean ignores it\n/,
      );
      assert.match(result.stdout, /\n {2}NO_UPDATE_NOTIFIER, CI {8}Either one/);
      assert.match(result.stdout, /ajs dms workspaces lists them\.\n$/);
      for (const line of result.stdout.split("\n")) {
        assert.ok(line.length <= HELP_WIDTH, line);
      }
    }
  });
});

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
  function nodeEnvWorkspace(): Record<string, string> {
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

describe("reporting what the verify-source runner found", () => {
  it("sends a package without package.json back as a usage error", async () => {
    const result = await runCli(["verify-source", "-l", "packages"], {
      files: { "packages/broken/dms.frontend.ts": "export default {};\n" },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✖ No package\.json in \.\/packages\/broken\n {2}→ Pass the root of a DMS frontend package/,
    );
    assert.doesNotMatch(
      result.stderr,
      /ENOENT|Error:|^\s+at |Source verification failed/m,
    );
  });

  it("names a directory without any package", async () => {
    const result = await runCli(["verify-source", "-l", "empty"], {
      files: { "empty/README.md": "" },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /^✖ No frontend package in \.\/empty\n/);
  });

  it("sends a frontend module passed with -l to -m", async () => {
    const result = await runCli(["verify-source", "-l", "frontend-vue"], {
      files: {
        "frontend-vue/package.json": JSON.stringify({ name: "demo-frontend" }),
        "frontend-vue/dms.frontend.ts": "export default {};\n",
      },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✖ \.\/frontend-vue is not the DMS core layer\n/,
    );
    assert.match(
      result.stderr,
      /\n {2}→ Drop -l and pass the folder with -m: ajs dms verify-source -m \.\/frontend-vue\n$/,
    );
    assert.doesNotMatch(result.stderr, /Materializ|ApexCharts|node_modules/);
  });

  it("asks to install @antelopejs/dms when the project has none", async () => {
    const result = await runCli(["verify-source", "-m", "frontend-vue"], {
      files: {
        "package.json": JSON.stringify({ name: "demo" }),
        "frontend-vue/package.json": JSON.stringify({ name: "demo-frontend" }),
        "frontend-vue/dms.frontend.ts": "export default {};\n",
      },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(
      result.stderr,
      "✖ @antelopejs/dms is not installed in this project\n" +
        "  Frontend modules are verified on top of the DMS core layer that @antelopejs/dms ships, and Node finds no @antelopejs/dms from the current directory.\n" +
        "  → Add it as a development dependency: pnpm add -D @antelopejs/dms\n",
    );
  });
});

describe("explaining an unreachable backend", () => {
  async function closedBackendUrl(): Promise<string> {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    return `http://127.0.0.1:${port}`;
  }

  it("names the URL and the cause in dev and prepare", async () => {
    const backendUrl = await closedBackendUrl();
    for (const command of ["dev", "prepare"]) {
      const result = await runCli([command, "-b", backendUrl], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(result.code, command === "prepare" ? 0 : 1, command);
      assert.match(
        result.stderr,
        new RegExp(
          `\n(✖|▲ Skipped prepare:) Cannot reach the DMS backend at ${backendUrl}\n`,
        ),
        command,
      );
      assert.doesNotMatch(result.stderr, /Setup failed/);
      assert.match(result.stderr, /Connection refused \(ECONNREFUSED\)\./);
      assert.match(result.stderr, /→ Start the backend/);
      assert.doesNotMatch(result.stderr, /fetch failed/);
    }
  });
});

describe("telling a skipped prepare from a failed one", () => {
  const STRICT_HINT =
    /\n {2}prepare never fails an install; add --strict to make this an error\.\n$/;

  async function closedBackendUrl(): Promise<string> {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    return `http://127.0.0.1:${port}`;
  }

  /** A backend answering every request with `status` and `body`. */
  async function withBackend(
    status: number,
    body: unknown,
    run: (backendUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((settle) =>
      server.listen({ port: 0, host: "127.0.0.1" }, settle),
    );
    const address = addressOf(server);
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise((settle) => server.close(settle));
    }
  }

  it("skips without a backend URL, and needs one with --strict", async () => {
    const skipped = await runCli(["prepare"]);
    assert.equal(skipped.code, 0);
    assert.match(skipped.stderr, /^▲ Skipped prepare: no backend URL\n/);
    assert.match(skipped.stderr, STRICT_HINT);

    const strict = await runCli(["prepare", "--strict"]);
    assert.equal(strict.code, 2);
    assert.equal(strict.stdout, "");
    assert.match(strict.stderr, /^✖ Backend URL is required\n/);
  });

  it("reads --strict from DMS_PREPARE_STRICT, in the environment or ./.env", async () => {
    const fromEnv = await runCli(["prepare"], {
      env: { DMS_PREPARE_STRICT: "1" },
    });
    assert.equal(fromEnv.code, 2);
    const fromFile = await runCli(["prepare"], {
      files: { ".env": "DMS_PREPARE_STRICT=true\n" },
    });
    assert.equal(fromFile.code, 2);
    for (const value of ["0", "false", "off", ""]) {
      const off = await runCli(["prepare"], {
        env: { DMS_PREPARE_STRICT: value },
      });
      assert.equal(off.code, 0, value);
    }
  });

  it("skips while the backend is out of reach, and fails with --strict", async () => {
    const backendUrl = await closedBackendUrl();
    const skipped = await runCli(["prepare", "-b", backendUrl]);
    assert.equal(skipped.code, 0);
    assert.match(
      skipped.stderr,
      /▲ Skipped prepare: Cannot reach the DMS backend/,
    );
    assert.match(
      skipped.stderr,
      /\n {2}The types and the module registry were not generated\.\n/,
    );
    assert.match(skipped.stderr, STRICT_HINT);

    const strict = await runCli(["prepare", "-b", backendUrl, "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /\n✖ Cannot reach the DMS backend at /);
    assert.doesNotMatch(strict.stderr, /Skipped prepare|--strict/);
  });

  it("skips offline without a cached manifest, and fails with --strict", async () => {
    const args = ["prepare", "-b", BACKEND_URL, "--offline"];
    const skipped = await runCli(args);
    assert.equal(skipped.code, 0);
    assert.match(
      skipped.stderr,
      /▲ Skipped prepare: No cached manifest for this workspace\n/,
    );

    const strict = await runCli([...args, "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /✖ No cached manifest for this workspace\n/);
  });

  it("reports a refused credential as a failure, an error with --strict", async () => {
    await withBackend(401, {}, async (backendUrl) => {
      const env = { DMS_BOOTSTRAP_SECRET: undefined };
      const failed = await runCli(["prepare", "-b", backendUrl], { env });
      assert.equal(failed.code, 0);
      assert.equal(failed.stdout, "");
      assert.match(
        failed.stderr,
        /▲ Prepare failed: The backend requires a bootstrap credential \(401\)/,
      );
      assert.match(failed.stderr, /→ Production\/CI: set DMS_BOOTSTRAP_SECRET/);
      assert.match(failed.stderr, STRICT_HINT);

      const strict = await runCli(["prepare", "-b", backendUrl, "--strict"], {
        env,
      });
      assert.equal(strict.code, 1);
      assert.match(
        strict.stderr,
        /\n✖ The backend requires a bootstrap credential \(401\)/,
      );
    });
  });

  it("reports an incompatible manifest as a failure, an error with DMS_PREPARE_STRICT", async () => {
    await withBackend(200, { version: 3, modules: [] }, async (backendUrl) => {
      const args = ["prepare", "-b", backendUrl];
      const failed = await runCli(args);
      assert.equal(failed.code, 0);
      assert.match(
        failed.stderr,
        /▲ Prepare failed: The backend serves frontend manifest version 3, which @antelopejs\/dms-frontend \S+ cannot read\n/,
      );

      const strict = await runCli(args, { env: { DMS_PREPARE_STRICT: "1" } });
      assert.equal(strict.code, 1);
      assert.match(
        strict.stderr,
        /\n✖ The backend serves frontend manifest version 3, which @antelopejs\/dms-frontend \S+ cannot read\n {2}This loader reads version 2; the backend's @antelopejs\/dms is newer than this loader\.\n {2}→ Upgrade the loader \(ajs update dms\) to a release that reads version 3\n/,
      );

      const off = await runCli(args, { env: { DMS_PREPARE_STRICT: "0" } });
      assert.equal(off.code, 0);
    });
  });
});

/**
 * `start` is the cheapest command that proves a variable reached Commander:
 * from a built project it touches no network, and names the URL it resolved
 * in its header.
 */
describe("loading the project .env", () => {
  const ENV_ONLY = {
    DMS_API_BASE_URL: undefined,
    DMS_SESSION_SECRET: "configured-session-secret-at-least-32-characters",
    PORT: "0",
  };
  const startedFor = (port: number) =>
    new RegExp(`^ajs dms start {2}http://127\\.0\\.0\\.1:${port} · `);

  it("fills a variable the environment does not define", async () => {
    const result = await runCli(["start"], {
      files: {
        ...builtWorkspace(),
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
      },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Backend URL is required/);
    assert.match(result.stderr, startedFor(5010));
  });

  it("lets a real environment variable win over the .env", async () => {
    const result = await runCli(["start"], {
      files: {
        ...builtWorkspace(),
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
      },
      env: { ...ENV_ONLY, DMS_API_BASE_URL: "http://127.0.0.1:5999" },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, startedFor(5999));
    assert.doesNotMatch(result.stderr, /5010/);
  });

  it("lets .env.local win over .env", async () => {
    const result = await runCli(["start"], {
      files: {
        ...builtWorkspace(),
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
        ".env.local": "DMS_API_BASE_URL=http://127.0.0.1:5011\n",
      },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, startedFor(5011));
  });

  it("runs normally in a directory with no .env", async () => {
    const result = await runCli(["start"], { env: ENV_ONLY });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Backend URL is required/);
  });

  it("documents the .env contract in the environment topic", async () => {
    const result = await runCli(["help", "environment"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /then \.\/\.env\.local, then \.\/\.env\)/);
    assert.match(
      result.stdout,
      /set in the shell wins over both files, and \.env\.local wins over \.env/,
    );
  });
});

/** A workspace stamped as the loader stamps one, holding `bytes` of files. */
function stampedWorkspace(
  workspaceKey: string,
  backendUrl: string,
  updatedAt: string,
  bytes: number,
): Record<string, string> {
  const hash = createHash("sha256").update(workspaceKey).digest("hex");
  const dir = join(".antelopejs", "dms-frontend", hash);
  const meta = JSON.stringify({ backendUrl, workspaceKey, updatedAt });
  return {
    [join(dir, ".ajs-dms-meta.json")]: meta,
    [join(dir, "node_modules", "pkg.js")]: "x".repeat(
      bytes - Buffer.byteLength(meta),
    ),
  };
}

const URL_WORKSPACE = stampedWorkspace(
  BACKEND_URL,
  BACKEND_URL,
  "2026-10-03T12:00:00.000Z",
  2048,
);
const PROJECT_WORKSPACE = stampedWorkspace(
  "project:/srv/demo",
  BACKEND_URL,
  "2026-10-03T13:00:00.000Z",
  1024,
);
const STRAY_DIR = join(".antelopejs", "dms-frontend", "stray-dir", "file");

describe("listing and removing workspaces", () => {
  it("prints one JSON document on stdout, whatever else is said", async () => {
    const result = await runCli(["workspaces", "--json"], {
      files: {
        ...URL_WORKSPACE,
        ...PROJECT_WORKSPACE,
        [STRAY_DIR]: "",
        [join(".antelopejs", "dms-frontend", "update-check.json")]:
          JSON.stringify({
            checkedAt: Date.now(),
            latestVersion: "999.0.0",
            succeeded: true,
          }),
      },
      env: { NO_UPDATE_NOTIFIER: undefined, CI: undefined },
    });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.stderr, /999\.0\.0/);
    assert.match(result.stderr, /– Skipped .*stray-dir \(not a workspace\)/);
    const listed = JSON.parse(result.stdout);
    const home = join(result.sandbox, ".antelopejs", "dms-frontend");
    assert.deepEqual(
      listed.map((entry: { dir: string }) => entry.dir.startsWith(home)),
      [true, true],
    );
    assert.deepEqual(
      listed.map(({ dir: _dir, ...entry }: { dir: string }) => entry),
      [
        {
          id: createHash("sha256").update("project:/srv/demo").digest("hex"),
          backendUrl: BACKEND_URL,
          key: { type: "project", path: "/srv/demo" },
          sizeBytes: 1024,
          lastUsedAt: "2026-10-03T13:00:00.000Z",
        },
        {
          id: createHash("sha256").update(BACKEND_URL).digest("hex"),
          backendUrl: BACKEND_URL,
          key: { type: "url" },
          sizeBytes: 2048,
          lastUsedAt: "2026-10-03T12:00:00.000Z",
        },
      ],
    );
  });

  it("prints an empty JSON list when there is no workspace", async () => {
    const result = await runCli(["workspaces", "--json"]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), []);
  });

  it("prints tab-separated lines without a header in a pipe", async () => {
    const result = await runCli(["workspaces"], { files: URL_WORKSPACE });
    assert.equal(result.code, 0);
    assert.equal(result.stderr, "");
    const fields = result.stdout.trimEnd().split("\t");
    assert.deepEqual(fields.slice(1, 6), [
      BACKEND_URL,
      "url",
      "",
      "2048",
      "2026-10-03T12:00:00.000Z",
    ]);
  });

  it("refuses to clean --all without a terminal to confirm on", async () => {
    const result = await runCli(["clean", "--all"], { files: URL_WORKSPACE });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^✖ Cannot prompt/);
    assert.match(
      result.stderr,
      /→ Pass it as a flag: ajs dms clean --all --yes/,
    );
    assert.ok(existsSync(join(result.sandbox, workspaceDir(BACKEND_URL))));
  });

  it("removes every workspace with --yes and says how much it freed", async () => {
    const result = await runCli(["clean", "--all", "--yes"], {
      files: { ...URL_WORKSPACE, ...PROJECT_WORKSPACE, [STRAY_DIR]: "" },
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    const lines = result.stderr.split("\n");
    assert.equal(lines[0], "✔ Removed 2 workspaces · freed 3 KB");
    assert.match(
      lines[1],
      /^ {2}[0-9a-f]{64} {2}http:\/\/127\.0\.0\.1:5010 {2}project \/srv\/demo$/,
    );
    assert.match(
      lines[2],
      /^ {2}[0-9a-f]{64} {2}http:\/\/127\.0\.0\.1:5010 {2}url$/,
    );
    assert.match(lines[3], /^– Skipped .*stray-dir \(not a workspace\)$/);
    const home = join(result.sandbox, ".antelopejs", "dms-frontend");
    assert.deepEqual(listNames(home), ["stray-dir"]);
  });
});

const UPDATE_DUE = {
  [join(".antelopejs", "dms-frontend", "update-check.json")]: JSON.stringify({
    checkedAt: Date.now(),
    latestVersion: "999.0.0",
    succeeded: true,
  }),
};
const UPDATE_ENV = {
  NO_UPDATE_NOTIFIER: undefined,
  CI: undefined,
  NO_COLOR: "1",
};
const UPDATE_NOTICE = `ℹ ajs dms 999.0.0 is available (you have ${OWN_PACKAGE.version}) → ajs update dms\n`;

describe("update notice", () => {
  it("ends a successful command on a terminal, after its own output", async () => {
    const result = await runCli(["clean", "--all"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
      isTerminal: true,
    });
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `ℹ No workspaces found\n\n${UPDATE_NOTICE}`);
  });

  it("stays out of pipes, failed commands and --json", async () => {
    const piped = await runCli(["clean", "--all"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
    });
    assert.equal(piped.stderr, "ℹ No workspaces found\n");

    const failed = await runCli(["clean"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
      isTerminal: true,
    });
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /^✖ Nothing to clean/);
    assert.doesNotMatch(failed.stderr, /999\.0\.0/);

    const json = await runCli(["workspaces", "--json"], {
      files: UPDATE_DUE,
      env: UPDATE_ENV,
      isTerminal: true,
    });
    assert.equal(json.code, 0);
    assert.doesNotMatch(json.stderr, /999\.0\.0/);
  });
});

/** A built workspace whose server prints the output settings it inherited. */
function settingsWorkspace(): Record<string, string> {
  return {
    ...builtWorkspace(),
    [join(PRODUCTION_WORKSPACE, "server.mjs")]:
      "const { ANTELOPEJS_QUIET, ANTELOPEJS_VERBOSE } = process.env;\n" +
      "console.log(JSON.stringify({ ANTELOPEJS_QUIET, ANTELOPEJS_VERBOSE }));\n",
  };
}

describe("global options after the command", () => {
  it("accepts -q and --verbose=<channels> before and after it", async () => {
    const listing = (result: { stdout: string; sandbox: string }) =>
      result.stdout.replaceAll(result.sandbox, "<home>");
    const plain = await runCli(["workspaces"], { files: URL_WORKSPACE });
    assert.equal(plain.code, 0);
    for (const args of [
      ["-q", "workspaces"],
      ["workspaces", "-q"],
      ["workspaces", "--quiet"],
      ["--verbose=vite", "workspaces"],
      ["workspaces", "--verbose=vite"],
      ["workspaces", "--verbose=vite,cli", "-q"],
      ["--verbose", "workspaces"],
    ]) {
      const result = await runCli(args, { files: URL_WORKSPACE });
      assert.equal(result.code, 0, args.join(" "));
      assert.equal(listing(result), listing(plain), args.join(" "));
      assert.equal(result.stderr, "", args.join(" "));
    }
  });

  it("prints the help for global options alone", async () => {
    for (const args of [["-q"], ["--verbose=vite"], ["-q", "--no-color"]]) {
      const result = await runCli(args);
      assert.equal(result.code, 0, args.join(" "));
      assert.match(result.stdout, /^Usage: ajs dms /m, args.join(" "));
    }
  });

  it("documents -q and --verbose=<channels> in the help and the environment topic", async () => {
    const help = await runCli(["--help"]);
    assert.match(
      help.stdout,
      /\n {2}--verbose \[=channels\] {2,}Show full output/,
    );
    assert.match(
      help.stdout,
      /\n {2}-q, --quiet {2,}Print only results, warnings and errors/,
    );
    const topic = await runCli(["help", "environment"]);
    assert.match(topic.stdout, /\n {2}ANTELOPEJS_QUIET {2,}Same as -q/);
  });

  it("hands them on to the server as ajs does when given before dms", async () => {
    const settings = async (args: string[]) => {
      const result = await runCli(
        [...args.slice(0, 1), "-b", BACKEND_URL, "-p", "0", ...args.slice(1)],
        {
          files: settingsWorkspace(),
          env: { DMS_SESSION_SECRET: SESSION_SECRET },
        },
      );
      assert.equal(result.code, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    assert.deepEqual(await settings(["start", "-q", "--verbose=vite"]), {
      ANTELOPEJS_QUIET: "1",
      ANTELOPEJS_VERBOSE: "vite",
    });
    assert.deepEqual(await settings(["start", "--verbose"]), {
      ANTELOPEJS_VERBOSE: "*",
    });
    assert.deepEqual(await settings(["start"]), {});
  });
});

describe("quiet runs", () => {
  it("print the results of workspaces and nothing else", async () => {
    const listing = (result: { stdout: string; sandbox: string }) =>
      result.stdout.replaceAll(result.sandbox, "<home>");
    const files = { ...URL_WORKSPACE, [STRAY_DIR]: "" };
    const plain = await runCli(["workspaces"], { files });
    assert.match(plain.stderr, /Skipped/);
    for (const options of [
      { args: ["workspaces", "-q"], env: {} },
      { args: ["workspaces"], env: { ANTELOPEJS_QUIET: "1" } },
    ]) {
      const quiet = await runCli(options.args, { files, env: options.env });
      assert.equal(quiet.code, 0);
      assert.equal(listing(quiet), listing(plain));
      assert.equal(quiet.stderr, "");
    }
  });

  it("clean silently, and still report a usage error", async () => {
    const cleaned = await runCli(["clean", "--all", "--yes", "-q"], {
      files: { ...URL_WORKSPACE, ...PROJECT_WORKSPACE },
    });
    assert.equal(cleaned.code, 0);
    assert.equal(cleaned.stdout, "");
    assert.equal(cleaned.stderr, "");
    assert.deepEqual(
      listNames(join(cleaned.sandbox, ".antelopejs", "dms-frontend")),
      [],
    );

    const usage = await runCli(["clean", "-q"]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /^✖ Nothing to clean: pass -b <url> or --all\n/);
  });

  it("open start, build and dev without their header, and keep their errors", async () => {
    const started = await runCli(
      ["start", "-b", BACKEND_URL, "-p", "0", "-q"],
      {
        files: builtWorkspace(),
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      },
    );
    assert.equal(started.code, 0);
    assert.match(started.stdout, /^server port \d+\n$/);
    assert.match(started.stderr, /^▲ DMS_HTML_RENDER_SECRET is not set/);
    assert.doesNotMatch(started.stderr, /ajs dms start/);

    const dev = await runCli(["dev", "-b", "http://127.0.0.1:9"], {
      env: { DMS_SESSION_SECRET: SESSION_SECRET, ANTELOPEJS_QUIET: "1" },
    });
    assert.equal(dev.code, 1);
    assert.match(dev.stderr, /^✖ Cannot reach the DMS backend/);
    assert.doesNotMatch(dev.stderr, /ajs dms dev {2}/);

    const build = await runCli(["build"], {
      env: { DMS_SESSION_SECRET: SESSION_SECRET, ANTELOPEJS_QUIET: "1" },
    });
    assert.equal(build.code, 1);
    assert.match(
      build.stderr,
      /^✖ Could not evaluate the project's configuration/,
    );
    assert.doesNotMatch(build.stderr, /ajs dms build {2}/);
  });

  it("keep the warning of a skipped prepare", async () => {
    const result = await runCli(["prepare", "--quiet"]);
    assert.equal(result.code, 0);
    assert.match(result.stderr, /^▲ Skipped prepare: no backend URL\n/);
  });

  it("are quiet only when ANTELOPEJS_QUIET is on", async () => {
    for (const value of ["0", "false"]) {
      const result = await runCli(["clean", "--all"], {
        env: { ANTELOPEJS_QUIET: value },
      });
      assert.match(result.stderr, /No workspaces found/, value);
    }
  });

  it("leave out the update notice", async () => {
    for (const env of [{}, { ANTELOPEJS_QUIET: "1" }]) {
      const result = await runCli(
        ["clean", "--all", ...("ANTELOPEJS_QUIET" in env ? [] : ["-q"])],
        {
          files: UPDATE_DUE,
          env: { ...UPDATE_ENV, ...env },
          isTerminal: true,
        },
      );
      assert.equal(result.code, 0);
      assert.equal(result.stderr, "");
    }
  });
});
