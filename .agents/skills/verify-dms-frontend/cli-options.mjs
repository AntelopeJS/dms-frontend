import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { observe, plain, runCli, runCliOnTerminal, sameText, scratch } from "./cli-run.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const EMPTY_LISTING = "ℹ No workspaces in ~/.antelopejs/dms-frontend\n";
const SECRET_32 = "s".repeat(32);
const SECRET_REQUIRED_FIX = "  start signs sessions with it, so it must stay the same across restarts.\n  → Create one: openssl rand -hex 32, then set it in the environment or ./.env\n";
const PORT_FIX = "  → Pass a number between 1 and 65535, or 0 for any free port: -p 3001\n";
const ESCAPE = "\u001b[";

/**
 * @param {string} dir A fresh working directory
 * @param {string} name A file name
 * @param {string} text Its content
 */
function put(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

/**
 * @typedef {{ name: string, args: string[], env?: Record<string, string | undefined>, code: number, stdout?: string, stderr: string }} Case
 */

export const journeys = [
  {
    id: "global-options",
    title: "-q, --no-color, --verbose and their variables work before and after the command name",
    entryPoint: "ajs dms [-q|--no-color|--verbose[=channels]] <command> [...]",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      /**
       * @param {string[]} args The arguments
       * @param {Record<string, string | undefined>} [env] More variables
       */
      const run = (args, env) => runCli(ctx, args, { home, env });
      const plainRun = await run(["workspaces"]);
      const quiet = {
        "-q before": await run(["-q", "workspaces"]),
        "-q after": await run(["workspaces", "-q"]),
        "--quiet before": await run(["--quiet", "workspaces"]),
        "--quiet after": await run(["workspaces", "--quiet"]),
        "ANTELOPEJS_QUIET=1": await run(["workspaces"], { ANTELOPEJS_QUIET: "1" }),
      };
      const loud = {
        "ANTELOPEJS_QUIET=0": await run(["workspaces"], { ANTELOPEJS_QUIET: "0" }),
        "ANTELOPEJS_QUIET=false": await run(["workspaces"], { ANTELOPEJS_QUIET: "false" }),
      };
      observe(ctx, "quiet leaves out information, 0 and false do not turn it on", { plainRun, quiet, loud }, [
        ctx.equal("by default the empty listing is said on stderr, nothing on stdout", [plainRun.code, plainRun.stdout, plainRun.stderr], [0, "", EMPTY_LISTING]),
        ...Object.entries(quiet).map(([name, result]) => ctx.equal(`${name} prints nothing`, [result.code, result.stdout, result.stderr], [0, "", ""])),
        ...Object.entries(loud).map(([name, result]) => ctx.equal(`${name} keeps the information`, [result.code, result.stderr], [0, EMPTY_LISTING])),
      ]);

      const resultKept = await run(["-q", "help", "environment"]);
      const failureKept = await run(["-q", "start"]);
      await ctx.verify("-q keeps results and errors", [
        ctx.holds("help environment still prints under -q", resultKept.stdout.startsWith("Environment (read from the shell"), resultKept.stdout.slice(0, 80)),
        ctx.equal("a usage error still prints under -q", [failureKept.code, failureKept.stderr], [2, "✖ Backend URL is required\n  → Pass -b <url> or set DMS_API_BASE_URL\n"]),
      ]);

      const colored = await runCliOnTerminal(ctx, ["workspaces"], { home, env: { NO_COLOR: undefined, CI: undefined } });
      const flagged = {
        "--no-color before": await runCliOnTerminal(ctx, ["--no-color", "workspaces"], { home, env: { NO_COLOR: undefined, CI: undefined } }),
        "--no-color after": await runCliOnTerminal(ctx, ["workspaces", "--no-color"], { home, env: { NO_COLOR: undefined, CI: undefined } }),
        "NO_COLOR=1": await runCliOnTerminal(ctx, ["workspaces"], { home }),
      };
      const dumb = await run(["workspaces"], { TERM: "dumb" });
      const xterm = await run(["workspaces"], { TERM: "xterm-256color" });
      observe(ctx, "colors and symbols", { colored, flagged, dumb, xterm }, [
        ctx.holds("on a terminal the line is colored by default", colored.stdout.includes(ESCAPE), JSON.stringify(colored.stdout)),
        ...Object.entries(flagged).map(([name, result]) =>
          ctx.equal(`${name}: no color, same words`, [result.stdout.includes(ESCAPE), plain(result.stdout)], [false, EMPTY_LISTING]),
        ),
        ctx.equal("TERM=dumb draws ASCII symbols", dumb.stderr, "i No workspaces in ~/.antelopejs/dms-frontend\n"),
        ctx.equal("a Unicode terminal draws the Unicode symbol", xterm.stderr, EMPTY_LISTING),
      ]);

      const ajs = join(ctx.state.runPlayground, "node_modules", "@antelopejs", "core", "dist", "core", "cli", "index.js");
      const wrapper = {
        "ajs dms workspaces": await runCli(ctx, ["dms", "workspaces"], { home, script: ajs, cwd: ctx.state.runPlayground }),
        "ajs -q dms workspaces": await runCli(ctx, ["-q", "dms", "workspaces"], { home, script: ajs, cwd: ctx.state.runPlayground }),
        "ajs --verbose dms build": await runCli(ctx, ["--verbose", "dms", "build", "--project", join(scratch(ctx, "blocker2"), "x")], { home, script: ajs, cwd: ctx.state.runPlayground }),
      };
      observe(ctx, "the options given to ajs before the plugin name reach the plugin", wrapper, [
        ctx.equal("ajs dms workspaces prints the information", [wrapper["ajs dms workspaces"].code, wrapper["ajs dms workspaces"].stderr], [0, EMPTY_LISTING]),
        ctx.equal("ajs -q dms workspaces is quiet", [wrapper["ajs -q dms workspaces"].code, wrapper["ajs -q dms workspaces"].stderr], [0, ""]),
        ctx.holds("ajs --verbose dms build adds the stack trace to the failure", /\n\s+at \S+/.test(wrapper["ajs --verbose dms build"].stderr), wrapper["ajs --verbose dms build"].stderr),
      ]);

      const blocker = join(scratch(ctx, "blocker"), "plain-file");
      writeFileSync(blocker, "not a directory");
      const failing = ["build", "--project", blocker];
      const terse = await run(failing);
      const verbose = {
        "--verbose before": await run(["--verbose", ...failing]),
        "--verbose after": await run([...failing, "--verbose"]),
        "--verbose=vite": await run(["--verbose=vite", ...failing]),
        "ANTELOPEJS_VERBOSE=1": await run(failing, { ANTELOPEJS_VERBOSE: "1" }),
      };
      const stack = /\n\s+at \S+/;
      observe(ctx, "verbose adds the stack trace of the underlying error, and --verbose build still runs build", { terse, verbose }, [
        ctx.equal("without it: exit 1, the title, the fix, no stack", [terse.code, stack.test(terse.stderr), terse.stderr.includes(`Not a directory: ${blocker}/.dms-frontend`), terse.stderr.includes("→ Pass the path of a directory")], [1, false, true, true]),
        ...Object.entries(verbose).map(([name, result]) =>
          ctx.equal(`${name}: exit 1 with a stack trace that names the failing call`, [result.code, stack.test(result.stderr), result.stderr.includes("ensureExplicitWorkspace"), result.stderr.startsWith("ajs dms build ")], [1, true, true, true]),
        ),
      ]);
    },
  },
  {
    id: "exit-codes",
    title: "a usage error exits 2 with the fix on stderr, a failure exits 1, a success exits 0; ports and the session secret are checked at their limits",
    entryPoint: "ajs dms start / clean with bad input; the exit-code table of docs/3.cli/1.overview.md",
    async run(/** @type {Context} */ ctx) {
      const cwd = scratch(ctx, "cwd");
      const url = "http://127.0.0.1:9";
      const secret = { DMS_SESSION_SECRET: SECRET_32 };
      /** @type {Case[]} */
      const cases = [
        { name: "unknown command", args: ["bogus"], code: 2, stderr: "✖ Unknown command 'bogus'\n  Usage: ajs dms [options] [command]\n  → Run ajs dms --help for usage\n" },
        { name: "unknown option of a command", args: ["build", "--bogus"], code: 2, stderr: "✖ Unknown option '--bogus'\n  Usage: ajs dms build [options]\n  → Run ajs dms build --help for usage\n" },
        { name: "missing option argument", args: ["start", "-b"], code: 2, stderr: "✖ Option '-b, --backend-url <url>' argument missing\n  Usage: ajs dms start [options]\n  → Run ajs dms start --help for usage\n" },
        { name: "no backend url", args: ["start"], code: 2, stderr: "✖ Backend URL is required\n  → Pass -b <url> or set DMS_API_BASE_URL\n" },
        { name: "url without a scheme", args: ["start", "-b", "localhost:5010"], code: 2, stderr: "✖ Invalid backend URL 'localhost:5010'\n  → Include the scheme: -b http://localhost:5010\n" },
        { name: "url with another scheme", args: ["start", "-b", "ftp://x:1"], code: 2, stderr: "✖ Invalid backend URL 'ftp://x:1'\n  → Use an http:// or https:// URL: -b http://localhost:5010\n" },
        { name: "port above the range", args: ["start", "-b", url, "-p", "65536"], env: secret, code: 2, stderr: `✖ Invalid port '65536'\n${PORT_FIX}` },
        { name: "port well above the range", args: ["start", "-b", url, "-p", "70000"], env: secret, code: 2, stderr: `✖ Invalid port '70000'\n${PORT_FIX}` },
        { name: "negative port", args: ["start", "-b", url, "-p", "-1"], env: secret, code: 2, stderr: `✖ Invalid port '-1'\n${PORT_FIX}` },
        { name: "port with trailing letters", args: ["start", "-b", url, "-p", "3001abc"], env: secret, code: 2, stderr: `✖ Invalid port '3001abc'\n${PORT_FIX}` },
        { name: "port 65535 is valid: the run goes on to the missing build", args: ["start", "-b", url, "-p", "65535"], env: secret, code: 1, stderr: "✖ No production build to serve\n  ./.dms-frontend has no built server or client.\n  → Build it first: ajs dms build\n" },
        { name: "port 0 is valid", args: ["start", "-b", url, "-p", "0"], env: secret, code: 1, stderr: "✖ No production build to serve\n  ./.dms-frontend has no built server or client.\n  → Build it first: ajs dms build\n" },
        { name: "port 1 is valid", args: ["start", "-b", url, "-p", "1"], env: secret, code: 1, stderr: "✖ No production build to serve\n  ./.dms-frontend has no built server or client.\n  → Build it first: ajs dms build\n" },
        { name: "PORT variable out of range", args: ["start", "-b", url], env: { ...secret, PORT: "65536" }, code: 2, stderr: `✖ Invalid port '65536'\n${PORT_FIX}` },
        { name: "no session secret", args: ["start", "-b", url], code: 2, stderr: `✖ DMS_SESSION_SECRET is not set\n${SECRET_REQUIRED_FIX}` },
        { name: "empty session secret", args: ["start", "-b", url], env: { DMS_SESSION_SECRET: "" }, code: 2, stderr: `✖ DMS_SESSION_SECRET is empty\n${SECRET_REQUIRED_FIX}` },
        { name: "31 characters are too short", args: ["start", "-b", url], env: { DMS_SESSION_SECRET: "s".repeat(31) }, code: 2, stderr: `✖ DMS_SESSION_SECRET is too short: 31 characters, at least 32 needed\n${SECRET_REQUIRED_FIX}` },
        { name: "5 characters are too short", args: ["start", "-b", url], env: { DMS_SESSION_SECRET: "short" }, code: 2, stderr: `✖ DMS_SESSION_SECRET is too short: 5 characters, at least 32 needed\n${SECRET_REQUIRED_FIX}` },
        { name: "32 characters are accepted: the run goes on to the missing build", args: ["start", "-b", url], env: secret, code: 1, stderr: "✖ No production build to serve\n  ./.dms-frontend has no built server or client.\n  → Build it first: ajs dms build\n" },
        { name: "start with --workspace names the workspace in the fix", args: ["start", "-b", url, "--workspace", "out"], env: secret, code: 1, stderr: "✖ No production build to serve\n  ./out has no built server or client.\n  → Build it first: ajs dms build --workspace out\n" },
        { name: "DMS_WORKSPACE_DIR is --workspace", args: ["start", "-b", url], env: { ...secret, DMS_WORKSPACE_DIR: "from-env" }, code: 1, stderr: "✖ No production build to serve\n  ./from-env has no built server or client.\n  → Build it first: ajs dms build --workspace from-env\n" },
        { name: "success", args: ["workspaces", "--json"], code: 0, stdout: "[]\n", stderr: "" },
      ];
      const results = [];
      const checks = [];
      for (const entry of cases) {
        const result = await runCli(ctx, entry.args, { cwd, home: scratch(ctx, "home"), env: entry.env });
        results.push({ ...entry, result });
        checks.push(ctx.equal(`${entry.name}: exit code, stdout, stderr`, [result.code, result.stdout, result.stderr], [entry.code, entry.stdout ?? "", entry.stderr]));
      }
      observe(ctx, "exit codes and messages", results, checks);

      const overview = docsPage(ctx, "3.cli/1.overview.md");
      const strict = await runCli(ctx, ["prepare", "--strict"], { cwd });
      const documented = exampleOutput(overview, "ajs dms prepare --strict");
      observe(ctx, "the usage error shown on the overview page", { strict, documented }, [
        sameText(ctx, "prepare --strict without a backend prints the page's text", strict.stderr.trimEnd(), documented ?? "<no block>"),
        ctx.equal("it exits 2", strict.code, 2),
      ]);
    },
  },
  {
    id: "env-files",
    title: ".env.local then .env are read from the working directory only and never overwrite a variable the shell set, an empty one included",
    entryPoint: "ajs dms start with DMS_API_BASE_URL from the shell, ./.env.local, ./.env",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const base = scratch(ctx, "base");
      /**
       * @param {string} cwd The working directory
       * @param {Record<string, string | undefined>} [env] More variables
       */
      const probe = (cwd, env) => runCli(ctx, ["start"], { cwd, home, env });
      const invalid = (value) => `✖ Invalid backend URL '${value}'\n  → Include the scheme: -b http://${value}\n`;
      const required = "✖ Backend URL is required\n  → Pass -b <url> or set DMS_API_BASE_URL\n";

      const dotenv = join(base, "only-env");
      put(dotenv, ".env", "DMS_API_BASE_URL=from-dotenv:1\n");
      const both = join(base, "both");
      put(both, ".env", "DMS_API_BASE_URL=from-dotenv:1\n");
      put(both, ".env.local", "DMS_API_BASE_URL=from-local:1\n");
      const quoted = join(base, "quoted");
      put(quoted, ".env", '# a comment\nOTHER=1\nDMS_API_BASE_URL="quoted:1"\n');
      const nested = join(base, "parent");
      put(nested, ".env", "DMS_API_BASE_URL=from-parent:1\n");
      mkdirSync(join(nested, "child"), { recursive: true });
      const none = join(base, "none");
      mkdirSync(none, { recursive: true });

      const results = {
        dotenv: await probe(dotenv),
        localBeatsDotenv: await probe(both),
        shellBeatsFiles: await probe(both, { DMS_API_BASE_URL: "from-shell:1" }),
        emptyShellCounts: await probe(both, { DMS_API_BASE_URL: "" }),
        quoted: await probe(quoted),
        parentNotRead: await probe(join(nested, "child")),
        noFile: await probe(none),
      };
      observe(ctx, "which value wins", results, [
        ctx.equal(".env is read", [results.dotenv.code, results.dotenv.stderr], [2, invalid("from-dotenv:1")]),
        ctx.equal(".env.local wins over .env", [results.localBeatsDotenv.code, results.localBeatsDotenv.stderr], [2, invalid("from-local:1")]),
        ctx.equal("a variable of the shell wins over both files", [results.shellBeatsFiles.code, results.shellBeatsFiles.stderr], [2, invalid("from-shell:1")]),
        ctx.equal("a variable exported empty counts as set: the files do not fill it", [results.emptyShellCounts.code, results.emptyShellCounts.stderr], [2, required]),
        ctx.equal("quotes and comments are parsed", [results.quoted.code, results.quoted.stderr], [2, invalid("quoted:1")]),
        ctx.equal("the parent directory's .env is not read", [results.parentNotRead.code, results.parentNotRead.stderr], [2, required]),
        ctx.equal("a missing file is not an error", [results.noFile.code, results.noFile.stderr], [2, required]),
      ]);

      const broken = join(base, "broken");
      put(broken, ".env", "DMS_API_BASE_URL=from-dotenv:1\n");
      mkdirSync(join(broken, ".env.local"));
      const skipped = await probe(broken);
      const listing = await runCli(ctx, ["workspaces"], { cwd: broken, home });
      observe(ctx, "an unreadable file is reported and skipped", { skipped, listing }, [
        ctx.equal("the warning names the file and the cause, then .env is still read", [skipped.code, skipped.stderr], [2, `▲ Ignoring ./.env.local: EISDIR: illegal operation on a directory, read\n${invalid("from-dotenv:1")}`]),
        ctx.equal("a command that needs nothing from it still succeeds", [listing.code, listing.stderr], [0, `▲ Ignoring ./.env.local: EISDIR: illegal operation on a directory, read\n${EMPTY_LISTING}`]),
      ]);

      const secret = join(base, "secret");
      put(secret, ".env", `DMS_SESSION_SECRET=${SECRET_32}\n`);
      const fromFile = await runCli(ctx, ["start", "-b", "http://127.0.0.1:9"], { cwd: secret, home });
      const cleaning = await runCli(ctx, ["clean"], { cwd: dotenv, home, env: { DMS_API_BASE_URL: "http://127.0.0.1:9" } });
      const cleaningFile = await runCli(ctx, ["clean"], { cwd: dotenv, home });
      const page = exampleOutput(docsPage(ctx, "3.cli/7.clean.md"), "ajs dms clean");
      observe(ctx, "secrets come from the file; clean never reads the backend url from the environment", { fromFile, cleaning, cleaningFile }, [
        ctx.equal("DMS_SESSION_SECRET in .env satisfies start", [fromFile.code, fromFile.stderr.startsWith("✖ No production build to serve")], [1, true]),
        ctx.equal("clean ignores DMS_API_BASE_URL of the shell", [cleaning.code, cleaning.stderr.split("\n")[0]], [2, "✖ Nothing to clean: pass -b <url> or --all"]),
        ctx.equal("clean ignores DMS_API_BASE_URL of ./.env", [cleaningFile.code, cleaningFile.stderr.split("\n")[0]], [2, "✖ Nothing to clean: pass -b <url> or --all"]),
        sameText(ctx, "the clean page shows this error", cleaning.stderr.trimEnd(), page ?? "<no block>"),
      ]);
    },
  },
  {
    id: "boolean-variables",
    title: "DMS_PREPARE_STRICT is on unless empty, 0, false, no or off, in any case and with spaces",
    entryPoint: "DMS_PREPARE_STRICT=<value> ajs dms prepare, without a backend",
    async run(/** @type {Context} */ ctx) {
      const off = ["", "0", "false", "no", "off", "OFF", "False", " No ", "NO"];
      const on = ["1", "true", "yes", "on", "TRUE", "2", "anything", "nope"];
      const results = {};
      for (const value of [...off, ...on]) {
        results[JSON.stringify(value)] = await runCli(ctx, ["prepare"], { env: { DMS_PREPARE_STRICT: value } });
      }
      const skipped = "▲ Skipped prepare: no backend URL\n  → Pass -b <url> or set DMS_API_BASE_URL to generate the types\n  prepare never fails an install; add --strict to make this an error.\n";
      const strict = "✖ Backend URL is required\n  → Pass -b <url> or set DMS_API_BASE_URL\n";
      const flag = await runCli(ctx, ["prepare", "--strict"], { env: { DMS_PREPARE_STRICT: "0" } });
      observe(ctx, "every value", { results, flag }, [
        ...off.map((value) => ctx.equal(`DMS_PREPARE_STRICT=${JSON.stringify(value)} leaves prepare lenient`, [results[JSON.stringify(value)].code, results[JSON.stringify(value)].stderr], [0, skipped])),
        ...on.map((value) => ctx.equal(`DMS_PREPARE_STRICT=${JSON.stringify(value)} makes it strict`, [results[JSON.stringify(value)].code, results[JSON.stringify(value)].stderr], [2, strict])),
        ctx.equal("--strict wins over DMS_PREPARE_STRICT=0", [flag.code, flag.stderr], [2, strict]),
      ]);
    },
  },
  {
    id: "update-notice",
    title: "a newer release is announced once, on stderr, after a command that succeeded on a terminal, and never for the silent cases",
    entryPoint: "~/.antelopejs/dms-frontend/update-check.json with a newer version, run on a pseudo terminal",
    async run(/** @type {Context} */ ctx) {
      const notice = (latest) => `ℹ ajs dms ${latest} is available (you have`;
      /**
       * @param {string} name The home's name
       * @param {string} latest The version the cache holds
       */
      const make = (name, latest) => {
        const home = scratch(ctx, name);
        mkdirSync(join(home, ".antelopejs", "dms-frontend"), { recursive: true });
        writeFileSync(join(home, ".antelopejs", "dms-frontend", "update-check.json"), `${JSON.stringify({ checkedAt: Date.now(), latestVersion: latest, succeeded: true })}\n`);
        return home;
      };
      const newer = make("newer", "99.0.0");
      const env = { CI: undefined, NO_UPDATE_NOTIFIER: undefined };
      /**
       * @param {string[]} args The arguments
       * @param {Record<string, string | undefined>} [extra] More variables
       * @param {string} [home] The home
       */
      const on = (args, extra = {}, home = newer) => runCliOnTerminal(ctx, args, { home, env: { ...env, ...extra } });
      const shown = await on(["workspaces"]);
      const cleaned = await on(["clean", "-b", "http://127.0.0.1:9"]);
      const silent = {
        "--no-update-check after the command": await on(["workspaces", "--no-update-check"]),
        "--no-update-check before the command": await on(["--no-update-check", "workspaces"]),
        "NO_UPDATE_NOTIFIER": await on(["workspaces"], { NO_UPDATE_NOTIFIER: "1" }),
        "CI": await on(["workspaces"], { CI: "1" }),
        "TERM=dumb": await on(["workspaces"], { TERM: "dumb" }),
        "-q": await on(["-q", "workspaces"]),
        "--version": await on(["--version"]),
        "--help": await on(["--help"]),
        "help workspaces": await on(["help", "workspaces"]),
        "a failed command": await on(["start"]),
      };
      const sameRelease = await on(["workspaces"], {}, make("same", "0.10.0"));
      const older = await on(["workspaces"], {}, make("older", "0.9.0"));
      const piped = await runCli(ctx, ["workspaces"], { home: newer, env });
      observe(ctx, "notice and silence", { shown, cleaned, silent, sameRelease, older, piped }, [
        ctx.holds("shown after the result of a successful command, the last line, with the command to run", shown.stdout.trimEnd().endsWith(`${notice("99.0.0")} 0.10.0) → ajs update dms`) && shown.stdout.startsWith("ℹ No workspaces in"), JSON.stringify(shown.stdout)),
        ctx.equal("it is set apart by one blank line", shown.stdout.split("\n").slice(0, 3).map((line) => line.trim() === ""), [false, true, false]),
        ctx.holds("shown after clean too", cleaned.stdout.includes(notice("99.0.0")), JSON.stringify(cleaned.stdout)),
        ...Object.entries(silent).map(([name, result]) => ctx.holds(`no notice: ${name}`, !result.stdout.includes("is available"), JSON.stringify(result.stdout))),
        ctx.holds("no notice when the release is the latest", !sameRelease.stdout.includes("is available"), JSON.stringify(sameRelease.stdout)),
        ctx.holds("no notice when the release is newer than the latest", !older.stdout.includes("is available"), JSON.stringify(older.stdout)),
        ctx.holds("no notice when piped", !piped.stderr.includes("is available") && !piped.stdout.includes("is available"), JSON.stringify(piped)),
      ]);
    },
  },
];
