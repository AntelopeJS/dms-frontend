import { rendererVersion } from "./cli-json.mjs";
import { environmentRows, docsPage, exampleOutput, flatten, maskVersion } from "./cli-docs.mjs";
import { observe, runCli, sameText } from "./cli-run.mjs";
import { standalone } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const COMMANDS = ["dev", "build", "start", "prepare", "workspaces", "clean", "verify-source"];
/** @type {Record<string, string>} */
const COMMAND_PAGES = {
  dev: "3.cli/2.dev.md",
  build: "3.cli/3.build.md",
  start: "3.cli/4.start.md",
  prepare: "3.cli/5.prepare.md",
  workspaces: "3.cli/6.workspaces.md",
  clean: "3.cli/7.clean.md",
  "verify-source": "3.cli/8.verify-source.md",
};

/**
 * @param {string} help A root help text
 * @returns {string[]} The command names its Commands section lists, in order
 */
function listedCommands(help) {
  const section = help.split("Commands:\n")[1]?.split("\n\n")[0] ?? "";
  return section
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0]);
}

/**
 * @param {string} help A help text
 * @returns {string} The text without the product title line some spellings print first
 */
function body(help) {
  return help.replace(/^ajs dms \S+ · .*\n\n/, "");
}

/**
 * @param {string} help A command's help text
 * @returns {string} The text without the Global Options and Examples sections, which the docs pages leave out
 */
function documentedPart(help) {
  return help
    .split("\n\n")
    .filter((paragraph) => !paragraph.startsWith("Global Options:") && !paragraph.startsWith("Examples:"))
    .join("\n\n");
}

export const journeys = [
  {
    id: "help-and-version",
    title: "--version prints the release, every spelling of help prints the same text the docs show, unknown help subjects are usage errors",
    entryPoint: "ajs dms --version, --help, -h, help [command], and no arguments",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const release = rendererVersion(ctx);
      const long = await runCli(ctx, ["--version"]);
      const short = await runCli(ctx, ["-v"]);
      await ctx.verify("--version and -v print the release alone on stdout and exit 0", [
        sameText(ctx, "--version stdout", long.stdout, `${release}\n`),
        sameText(ctx, "-v stdout", short.stdout, `${release}\n`),
        ctx.equal("--version exit code and stderr", [long.code, long.stderr], [0, ""]),
        ctx.equal("-v exit code and stderr", [short.code, short.stderr], [0, ""]),
      ]);

      const spellings = {
        "--help": await runCli(ctx, ["--help"]),
        "-h": await runCli(ctx, ["-h"]),
        bare: await runCli(ctx, []),
        help: await runCli(ctx, ["help"]),
      };
      const overview = docsPage(ctx, "3.cli/1.overview.md");
      const documented = exampleOutput(overview, "ajs dms --help");
      const root = spellings["--help"].stdout;
      observe(ctx, "root help in every spelling", spellings, [
        ...Object.entries(spellings).flatMap(([name, result]) => [
          ctx.equal(`${name} exits 0 with nothing on stderr`, [result.code, result.stderr], [0, ""]),
          sameText(ctx, `${name} prints the same text as --help`, result.stdout, root),
        ]),
        sameText(ctx, "the first line names the release and the product", root.split("\n")[0], `ajs dms ${release} · DMS frontend for AntelopeJS (Vue 3, Vite, Inertia)`),
        ctx.equal("the commands listed, in order", listedCommands(root), [...COMMANDS, "help"]),
        ctx.holds("the overview page shows this help", documented !== undefined && maskVersion(root.trimEnd()) === maskVersion(documented), documented === undefined ? "no block on the page" : "differs from the page"),
        ctx.holds("the global options are listed", ["-v, --version", "--no-color", "--verbose [=channels]", "-q, --quiet", "--no-update-check", "-h, --help"].every((option) => root.includes(option)), root),
      ]);

      const rows = [];
      const checks = [];
      for (const name of COMMANDS) {
        const forms = {
          long: await runCli(ctx, [name, "--help"]),
          short: await runCli(ctx, [name, "-h"]),
          topic: await runCli(ctx, ["help", name]),
        };
        rows.push({ name, forms });
        const page = exampleOutput(docsPage(ctx, COMMAND_PAGES[name]), `ajs dms ${name} --help`);
        const text = body(forms.long.stdout);
        checks.push(
          ctx.equal(`${name} --help, -h and help ${name} exit 0 and print to stdout only`, Object.values(forms).map((form) => [form.code, form.stderr]), [[0, ""], [0, ""], [0, ""]]),
          ctx.equal(`${name} -h and help ${name} print the text of --help`, [body(forms.short.stdout), body(forms.topic.stdout)], [text, text]),
          ctx.holds(`${name} --help also has Global Options (with --no-update-check) and Examples`, text.includes("\nGlobal Options:\n") && text.includes("--no-update-check") && text.includes("\nExamples:\n  #"), text.slice(-300)),
          ctx.holds(`${name} --help starts with its usage line`, text.trimStart().startsWith(`Usage: ajs dms ${name}`), text.slice(0, 120)),
          ctx.holds(`the ${name} page shows this help`, page !== undefined && flatten(documentedPart(text)) === flatten(page), page === undefined ? "no block on the page" : `page: ${flatten(page).slice(0, 160)} | actual: ${flatten(text).slice(0, 160)}`),
        );
      }
      observe(ctx, "every command's help is the text of its docs page", rows, checks);

      const unknown = await runCli(ctx, ["help", "bogus"]);
      const unknownOption = await runCli(ctx, ["--bogus"]);
      await ctx.verify("an unknown help subject or root option is a usage error on stderr", [
        ctx.equal("help bogus", [unknown.code, unknown.stdout, unknown.stderr], [2, "", "✖ Unknown command 'bogus'\n  Usage: ajs dms [options] [command]\n  → Run ajs dms --help for usage\n"]),
        ctx.equal("--bogus", [unknownOption.code, unknownOption.stdout, unknownOption.stderr], [2, "", "✖ Unknown option '--bogus'\n  Usage: ajs dms [options] [command]\n  → Run ajs dms --help for usage\n"]),
      ]);
    },
  },
  {
    id: "environment-topic",
    title: "help environment lists every variable the configuration page lists, in its order and words, then the .env rules",
    entryPoint: "ajs dms help environment, and docs/4.configuration.md",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      const topic = await runCli(ctx, ["help", "environment"]);
      const flat = flatten(topic.stdout);
      const rows = environmentRows(docsPage(ctx, "4.configuration.md"));
      let cursor = 0;
      const missing = [];
      for (const row of rows) {
        const needle = `${row.names} ${flatten(row.description)}`;
        const at = flat.indexOf(needle, cursor);
        if (at === -1) missing.push(needle);
        else cursor = at + needle.length;
      }
      const printedNames = topic.stdout
        .split("\n")
        .filter((line) => /^ {2}[A-Z]/.test(line))
        .map((line) => line.trim().split(/ {2,}/)[0]);
      observe(ctx, "the topic against the configuration page", { topic, rows }, [
        ctx.equal("exit code, stdout only", [topic.code, topic.stderr], [0, ""]),
        ctx.equal("the table has 26 variables", rows.length, 26),
        ctx.equal("the topic prints the same names, in the page's order", printedNames, rows.map((row) => row.names)),
        ctx.equal("every row of the page is in the topic with its description, in order", missing, []),
        ctx.holds("the heading names the shell, then .env.local, then .env", topic.stdout.startsWith("Environment (read from the shell, then ./.env.local, then ./.env)\n"), topic.stdout.split("\n")[0]),
        ctx.holds("the .env note: the shell wins and .env.local wins over .env", flat.includes("A variable set in the shell wins over both files, and .env.local wins over .env. Only the current directory is read: the generated workspace never loads a .env of its own."), flat.slice(-500)),
        ctx.holds("the workspaces note", flat.includes("Workspaces live in ~/.antelopejs/dms-frontend, one per backend URL. dev without -b keys its own on the project directory instead; pass -b to share one with build and start. ajs dms workspaces lists them."), flat.slice(-500)),
      ]);
      const quiet = await runCli(ctx, ["-q", "help", "environment"]);
      await ctx.verify("the topic is a result: -q keeps it", [sameText(ctx, "same text under -q", quiet.stdout, topic.stdout)]);
    },
  },
];
