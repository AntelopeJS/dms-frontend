import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { observe, plain, runCli, runCliOnTerminal, sameText, scratch } from "./cli-run.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const EMPTY_LISTING = "ℹ No workspaces in ~/.antelopejs/dms-frontend\n";
export const SECRET_32 = "s".repeat(32);
const SECRET_REQUIRED_FIX = "  start signs sessions with it, so it must stay the same across restarts.\n  → Create one: openssl rand -hex 32, then set it in the environment or ./.env\n";
const PORT_FIX = "  → Pass a number between 1 and 65535, or 0 for any free port: -p 3001\n";
const ESCAPE = "\u001b[";

/**
 * @param {string} dir A fresh working directory
 * @param {string} name A file name
 * @param {string} text Its content
 */
export function put(dir, name, text) {
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
];
