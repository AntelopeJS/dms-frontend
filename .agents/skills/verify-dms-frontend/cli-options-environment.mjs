import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { observe, runCli, runCliOnTerminal, sameText, scratch } from "./cli-run.mjs";
import { parseJson } from "./json.mjs";
import { EMPTY_LISTING, SECRET_32, put } from "./cli-options-flags.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const journeys = [
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
        "--json": await on(["workspaces", "--json"]),
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
        ctx.holds("--json prints the JSON and nothing else", Array.isArray(parseJson(silent["--json"].stdout.trim())), JSON.stringify(silent["--json"].stdout)),
        ctx.holds("no notice when the release is the latest", !sameRelease.stdout.includes("is available"), JSON.stringify(sameRelease.stdout)),
        ctx.holds("no notice when the release is newer than the latest", !older.stdout.includes("is available"), JSON.stringify(older.stdout)),
        ctx.holds("no notice when piped", !piped.stderr.includes("is available") && !piped.stdout.includes("is available"), JSON.stringify(piped)),
      ]);
    },
  },
];
