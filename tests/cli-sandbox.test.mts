import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { describe, it } from "node:test";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { OWN_PACKAGE } from "./helpers/own-package";
import {
  cliCommand,
  runCli,
  BACKEND_URL,
  ESC,
  SESSION_SECRET,
  COMMANDS,
  HELP_WIDTH,
} from "./fixtures/cli-sandbox.mts";

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
