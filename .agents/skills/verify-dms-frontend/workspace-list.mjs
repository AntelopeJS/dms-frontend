import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listedWorkspaces } from "./cli-json.mjs";
import { docsPage, exampleOutput } from "./cli-docs.mjs";
import { observe, runCli, runCliOnTerminal, sameText, scratch } from "./cli-run.mjs";
import { META_FILE, humanSize, sha256, workspacesRoot, writeForeign, writeWorkspace } from "./workspace-fixtures.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * @param {number} agoMs How long ago
 * @returns {string} That moment, ISO 8601
 */
function ago(agoMs) {
  return new Date(Date.now() - agoMs).toISOString();
}

/**
 * @param {string} text Piped `workspaces` output
 * @returns {string[][]} Its lines split at tabs
 */
function fields(text) {
  return text.split("\n").filter(Boolean).map((line) => line.split("\t"));
}

export const journeys = [
  {
    id: "workspaces-listing",
    title: "workspaces lists id, backend, key, size, last use: as a table on a terminal, as tab-separated lines piped, as JSON with --json",
    entryPoint: "ajs dms workspaces, | cat, --json, in a home holding hand-written workspaces",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const empty = await runCli(ctx, ["workspaces"], { home });
      const emptyJson = await runCli(ctx, ["workspaces", "--json"], { home });
      const emptyPiped = await runCli(ctx, ["workspaces"], { home });
      observe(ctx, "no workspace", { empty, emptyJson }, [
        ctx.equal("piped and empty: nothing on stdout, the information on stderr", [empty.code, empty.stdout, empty.stderr], [0, "", "ℹ No workspaces in ~/.antelopejs/dms-frontend\n"]),
        ctx.equal("--json and empty is an empty array and nothing else", [emptyJson.code, emptyJson.stdout, emptyJson.stderr], [0, "[]\n", ""]),
        ctx.equal("the same without --json", emptyPiped.stdout, ""),
      ]);

      const projectDir = scratch(ctx, "cwd");
      const newest = writeWorkspace(home, { key: `project:${projectDir}`, backendUrl: "http://127.0.0.1:5050", updatedAt: ago(30_000), padTo: 1_000 });
      const urlKeyed = writeWorkspace(home, { key: "http://127.0.0.1:5050", backendUrl: "http://127.0.0.1:5050", updatedAt: ago(70_000), padTo: 1_536 });
      const withLinks = writeWorkspace(home, { key: "http://127.0.0.1:5060", backendUrl: "http://127.0.0.1:5060", updatedAt: ago(HOUR - 30_000), files: { "a/data.bin": 4_000 }, linked: "b/same-data.bin" });
      const hours = writeWorkspace(home, { key: "http://127.0.0.1:5070", backendUrl: "http://127.0.0.1:5070", updatedAt: ago(HOUR + 30_000), padTo: 10_240 });
      const lastHour = writeWorkspace(home, { key: "http://127.0.0.1:5080", backendUrl: "http://127.0.0.1:5080", updatedAt: ago(24 * HOUR - 30_000), padTo: 1_048_576 });
      const oneDay = writeWorkspace(home, { key: "http://127.0.0.1:5090", backendUrl: "http://127.0.0.1:5090", updatedAt: ago(DAY + 30_000), padTo: 5_000_000 });
      const twoDays = writeWorkspace(home, { key: "http://127.0.0.1:5100", backendUrl: "http://127.0.0.1:5100", updatedAt: ago(2 * DAY + 30_000), padTo: 1_023 });
      const noDate = writeWorkspace(home, { key: "http://127.0.0.1:5110", backendUrl: "http://127.0.0.1:5110", padTo: 300, modified: new Date(Date.now() - 3 * DAY) });
      const badDate = writeWorkspace(home, { key: "http://127.0.0.1:5120", backendUrl: "http://127.0.0.1:5120", updatedAt: "not a date", padTo: 300, modified: new Date(Date.now() - 4 * DAY) });
      const foreign = writeForeign(home, "not-a-workspace", { "readme.txt": "mine" });
      const halfMeta = writeForeign(home, "no-backend-url", { [META_FILE]: JSON.stringify({ workspaceKey: "x" }) });
      const rootFile = join(workspacesRoot(home), "update-check.json");
      void rootFile;

      const order = [newest, urlKeyed, withLinks, hours, lastHour, oneDay, twoDays, noDate, badDate];
      const piped = await runCli(ctx, ["workspaces"], { home });
      const rows = fields(piped.stdout);
      const expectedRows = [
        [newest.id, "http://127.0.0.1:5050", "project", projectDir, String(newest.sizeBytes), null, newest.dir],
        [urlKeyed.id, "http://127.0.0.1:5050", "url", "", "1536", null, urlKeyed.dir],
        [withLinks.id, "http://127.0.0.1:5060", "url", "", String(withLinks.sizeBytes), null, withLinks.dir],
        [hours.id, "http://127.0.0.1:5070", "url", "", "10240", null, hours.dir],
        [lastHour.id, "http://127.0.0.1:5080", "url", "", "1048576", null, lastHour.dir],
        [oneDay.id, "http://127.0.0.1:5090", "url", "", "5000000", null, oneDay.dir],
        [twoDays.id, "http://127.0.0.1:5100", "url", "", "1023", null, twoDays.dir],
        [noDate.id, "http://127.0.0.1:5110", "url", "", "300", null, noDate.dir],
        [badDate.id, "http://127.0.0.1:5120", "url", "", "300", null, badDate.dir],
      ];
      const skipLines = piped.stderr.split("\n").filter(Boolean).sort();
      observe(ctx, "piped output", { piped, expectedRows }, [
        ctx.equal("exit 0, one line per workspace, no header", [piped.code, rows.length], [0, order.length]),
        ctx.equal("every line has 7 tab-separated fields", rows.map((row) => row.length), order.map(() => 7)),
        ctx.equal("ids in order of last use, most recent first, and the fields", rows.map((row) => row.map((cell, index) => (index === 5 ? null : cell))), expectedRows),
        ctx.equal("the id is the SHA-256 of the key, whole (64 hexadecimal characters)", [rows[1][0], rows[1][0].length], [sha256("http://127.0.0.1:5050"), 64]),
        ctx.equal("the recorded date is printed as ISO 8601; a missing or invalid one falls back to the file's modification time", [rows[0][5] < rows[1][5], Math.abs(Date.parse(rows[7][5]) - Date.now() + 3 * DAY) < 5 * MINUTE, Math.abs(Date.parse(rows[8][5]) - Date.now() + 4 * DAY) < 5 * MINUTE], [false, true, true]),
        ctx.holds("the recorded date is the one in the meta file", rows.every((row, index) => index > 6 || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row[5])), rows.map((row) => row[5]).join(" ")),
        ctx.equal("a directory without metadata and one without a backend url are reported as skipped on stderr, and listed nowhere", skipLines, [`– Skipped ${"~/.antelopejs/dms-frontend/no-backend-url"} (not a workspace)`, `– Skipped ${"~/.antelopejs/dms-frontend/not-a-workspace"} (not a workspace)`]),
        ctx.holds("neither skipped directory is in stdout", !piped.stdout.includes(foreign) && !piped.stdout.includes(halfMeta), piped.stdout),
      ]);

      const json = await runCli(ctx, ["workspaces", "--json"], { home });
      const parsed = listedWorkspaces(json.stdout);
      observe(ctx, "--json", { json }, [
        ctx.equal("the same workspaces in the same order", parsed.map((entry) => entry.id), order.map((entry) => entry.id)),
        ctx.equal("the fields the page documents, for a project-keyed workspace", parsed[0].fields, ["backendUrl", "dir", "id", "key", "lastUsedAt", "sizeBytes"]),
        ctx.equal("project key", [parsed[0].key, parsed[0].backendUrl, parsed[0].sizeBytes, parsed[0].dir], [{ type: "project", path: projectDir }, "http://127.0.0.1:5050", newest.sizeBytes, newest.dir]),
        ctx.equal("url key has no path", parsed[1].key, { type: "url" }),
        ctx.equal("sizes in bytes; a hard link counts once", parsed.map((entry) => entry.sizeBytes), [newest, urlKeyed, withLinks, hours, lastHour, oneDay, twoDays, noDate, badDate].map((entry) => entry.sizeBytes)),
        ctx.equal("stdout is the JSON only; the skipped directories go to stderr", [json.stdout.trimStart().startsWith("["), json.stderr.split("\n").filter(Boolean).length], [true, 2]),
      ]);

      const wide = await runCliOnTerminal(ctx, ["workspaces"], { home, columns: 100 });
      const cells = wide.stdout.split("\n").filter((line) => !line.startsWith("–") && line.trim()).map((line) => line.trim().split(/ {2,}/));
      observe(ctx, "on a wide terminal: a table", { wide }, [
        ctx.equal("the header", cells[0], ["ID", "BACKEND", "KEY", "SIZE", "LAST USED"]),
        ctx.equal("ids are cut to 8 characters, with backend and key", cells.slice(1).map((row) => row.slice(0, 3)), [
          [newest.id.slice(0, 8), "http://127.0.0.1:5050", "project ."],
          [urlKeyed.id.slice(0, 8), "http://127.0.0.1:5050", "url"],
          [withLinks.id.slice(0, 8), "http://127.0.0.1:5060", "url"],
          [hours.id.slice(0, 8), "http://127.0.0.1:5070", "url"],
          [lastHour.id.slice(0, 8), "http://127.0.0.1:5080", "url"],
          [oneDay.id.slice(0, 8), "http://127.0.0.1:5090", "url"],
          [twoDays.id.slice(0, 8), "http://127.0.0.1:5100", "url"],
          [noDate.id.slice(0, 8), "http://127.0.0.1:5110", "url"],
          [badDate.id.slice(0, 8), "http://127.0.0.1:5120", "url"],
        ]),
        ctx.equal("sizes: 1000 B, 1.5 KB, 4 KB (4116 bytes), 10 KB, 1 MB, 4.8 MB, 1023 B, 300 B", cells.slice(1).map((row) => row[3]), ["1000 B", "1.5 KB", "4 KB", "10 KB", "1 MB", "4.8 MB", "1023 B", "300 B", "300 B"]),
        ctx.equal("ages: under a minute, 1 min, 59 min, 1 h, 23 h, 1 day, 2 days, then the file dates 3 and 4 days", cells.slice(1).map((row) => row[4]), ["just now", "1 min ago", "59 min ago", "1 h ago", "23 h ago", "1 day ago", "2 days ago", "3 days ago", "4 days ago"]),
      ]);

      const narrow = await runCliOnTerminal(ctx, ["workspaces"], { home, columns: 40 });
      const blocks = narrow.stdout.split("\n\n");
      /**
      * @param {string} block A block of the listing
      * @param {string} name A label
      */
      const field = (block, name) => block.split("\n").find((line) => line.startsWith(name))?.slice(name.length).trim();
      observe(ctx, "on a narrow terminal: one block per workspace, as the page shows", { narrow }, [
        ctx.equal("the labels of the first block", blocks[0].split("\n").map((line) => line.split(/ {2,}/)[0]).slice(0, 5), ["ID", "BACKEND", "KEY", "SIZE", "LAST USED"]),
        ctx.equal("the first block", [field(blocks[0], "ID"), field(blocks[0], "BACKEND"), field(blocks[0], "SIZE"), field(blocks[0], "LAST USED")], [newest.id.slice(0, 8), "http://127.0.0.1:5050", "1000 B", "just now"]),
        ctx.equal("nine blocks", blocks.filter((block) => block.includes("BACKEND")).length, 9),
      ]);

      const page = docsPage(ctx, "3.cli/6.workspaces.md");
      observe(ctx, "docs", { example: exampleOutput(page, "ajs dms workspaces") }, [
        sameText(ctx, "the page's terminal example uses these labels", (exampleOutput(page, "ajs dms workspaces") ?? "").split("\n").filter((line) => /^[A-Z ]+ {2,}/.test(line)).slice(0, 5).map((line) => line.split(/ {2,}/)[0]).join(","), "ID,BACKEND,KEY,SIZE,LAST USED"),
      ]);
    },
  },
  {
    id: "clean-one-backend",
    title: "clean -b removes the workspace keyed on that url, whatever its spelling, and says what it freed; project-keyed workspaces and builds are left alone",
    entryPoint: "ajs dms clean -b <url>",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const key = "http://127.0.0.1:5999";
      const target = writeWorkspace(home, { key, backendUrl: key, updatedAt: ago(MINUTE), files: { "node_modules/pkg/index.js": 2_000, ".manifest-cache.json": 129 }, padTo: undefined });
      const otherUrl = writeWorkspace(home, { key: "http://127.0.0.1:5998", backendUrl: "http://127.0.0.1:5998", updatedAt: ago(MINUTE), padTo: 500 });
      const projectKeyed = writeWorkspace(home, { key: `project:${scratch(ctx, "proj")}`, backendUrl: key, updatedAt: ago(MINUTE), padTo: 500 });
      const spellings = ["http://localhost:5999", "http://localhost:5999/", "HTTP://LOCALHOST:5999", "http://[::1]:5999", "http://127.0.0.1:5999"];
      const results = [];
      const checks = [];
      let remaining = target;
      for (const spelling of spellings) {
        remaining = writeWorkspace(home, { key, backendUrl: key, updatedAt: ago(MINUTE), files: { "node_modules/pkg/index.js": 2_000, ".manifest-cache.json": 129 } });
        const result = await runCli(ctx, ["clean", "-b", spelling], { home });
        results.push({ spelling, result });
        checks.push(
          ctx.equal(`${spelling}: removed`, [result.code, existsSync(remaining.dir)], [0, false]),
          ctx.equal(`${spelling}: says so, with the size it freed, on stderr`, [result.stdout, result.stderr], ["", `✔ Removed workspace ~/.antelopejs/dms-frontend/${remaining.id} · ${spelling} · freed ${humanSize(remaining.sizeBytes)}\n`]),
        );
      }
      checks.push(ctx.equal("the other url's workspace and the project-keyed one are untouched", [existsSync(otherUrl.dir), existsSync(projectKeyed.dir)], [true, true]));
      observe(ctx, "equivalent spellings reach the same workspace", results, checks);

      const missing = await runCli(ctx, ["clean", "-b", "http://127.0.0.1:5999"], { home });
      const invalid = await runCli(ctx, ["clean", "-b", "localhost:5999"], { home });
      const withEnv = await runCli(ctx, ["clean", "-b", "http://127.0.0.1:5998"], { home, env: { DMS_API_BASE_URL: "http://127.0.0.1:5997" } });
      observe(ctx, "nothing to clean, bad url, environment ignored", { missing, invalid, withEnv }, [
        ctx.equal("no workspace for the url", [missing.code, missing.stderr], [0, "ℹ No workspace for http://127.0.0.1:5999: nothing to clean\n"]),
        ctx.equal("a url without a scheme is a usage error", [invalid.code, invalid.stderr], [2, "✖ Invalid backend URL 'localhost:5999'\n  → Include the scheme: -b http://localhost:5999\n"]),
        ctx.equal("-b wins and DMS_API_BASE_URL is not read", [withEnv.code, existsSync(otherUrl.dir), withEnv.stderr.startsWith("✔ Removed workspace")], [0, false, true]),
        ctx.equal("a project-keyed workspace is not reached by -b", existsSync(projectKeyed.dir), true),
      ]);

      const build = join(scratch(ctx, "project"), ".dms-frontend", "dist");
      mkdirSync(build, { recursive: true });
      const all = await runCli(ctx, ["clean", "--all", "--yes"], { home });
      observe(ctx, "clean never touches a production build", { all }, [
        ctx.equal("--all --yes removed the project-keyed workspace", existsSync(projectKeyed.dir), false),
        ctx.equal("the build of a project is still there", statSync(build).isDirectory(), true),
      ]);
    },
  },
  {
    id: "clean-all",
    title: "clean --all asks first: no terminal and no --yes is a usage error that removes nothing; --yes removes every workspace and lists them",
    entryPoint: "ajs dms clean --all [--yes] with and without a terminal",
    async run(/** @type {Context} */ ctx) {
      const home = scratch(ctx, "home");
      const first = writeWorkspace(home, { key: "http://127.0.0.1:5010", backendUrl: "http://127.0.0.1:5010", updatedAt: ago(2 * MINUTE), padTo: 2_048 });
      const second = writeWorkspace(home, { key: `project:${scratch(ctx, "p")}`, backendUrl: "http://127.0.0.1:5020", updatedAt: ago(MINUTE), padTo: 1_024 });
      const foreign = writeForeign(home, "foreign", { "keep.txt": "keep" });
      const present = () => [first.dir, second.dir, foreign].map((dir) => existsSync(dir));

      const refused = await runCli(ctx, ["clean", "--all"], { home });
      const refusedCi = await runCli(ctx, ["clean", "--all"], { home, env: { CI: "1" }, input: "y\n" });
      const refusedShort = await runCli(ctx, ["clean", "-a"], { home });
      const page = exampleOutput(docsPage(ctx, "3.cli/7.clean.md"), "ajs dms clean --all < /dev/null");
      observe(ctx, "without a terminal", { refused, refusedCi, refusedShort }, [
        ctx.equal("exit 2, nothing removed", [refused.code, present()], [2, [true, true, true]]),
        sameText(ctx, "the page's text", refused.stderr.trimEnd(), page ?? "<no block>"),
        ctx.equal("CI refuses too, even with an answer on stdin", [refusedCi.code, present()], [2, [true, true, true]]),
        ctx.equal("-a is --all", [refusedShort.code, refusedShort.stderr.split("\n")[0]], [2, "✖ Cannot prompt: this is not an interactive terminal"]),
      ]);

      const answered = await runCliOnTerminal(ctx, ["clean", "--all"], { home, env: { CI: undefined }, answer: "\r", waitForPrompt: "Continue?" });
      observe(ctx, "on a terminal, Enter takes the default: no", { answered }, [
        ctx.holds("it lists what it would remove, with the total, before asking", answered.stdout.includes("Remove 2 workspaces (3 KB)?") && answered.stdout.includes(`${second.id.slice(0, 8)}  http://127.0.0.1:5020  project`) && answered.stdout.includes(`${first.id.slice(0, 8)}  http://127.0.0.1:5010  url`), answered.stdout),
        ctx.holds("Nothing removed is said", answered.stdout.includes("Nothing removed"), answered.stdout),
        ctx.equal("exit 0 and every directory is still there", [answered.code, present()], [0, [true, true, true]]),
      ]);

      const yes = await runCli(ctx, ["clean", "--all", "--yes"], { home });
      observe(ctx, "--yes", { yes }, [
        ctx.equal("exit 0; both workspaces are gone, the foreign directory stays", [yes.code, present()], [0, [false, false, true]]),
        ctx.equal("stderr: the count, the size freed, each removed workspace, the skipped directory", yes.stderr.split("\n").filter(Boolean), [
          "✔ Removed 2 workspaces · freed 3 KB",
          `  ${second.id}  http://127.0.0.1:5020  project ${join(ctx.state.dir, "scratch", ctx.journey, "p")}`.replace(ctx.state.dir, ctx.state.dir),
          `  ${first.id}  http://127.0.0.1:5010  url`,
          "– Skipped ~/.antelopejs/dms-frontend/foreign (not a workspace)",
        ]),
      ]);

      const again = await runCli(ctx, ["clean", "--all", "--yes"], { home });
      const alone = writeWorkspace(home, { key: "http://127.0.0.1:5030", backendUrl: "http://127.0.0.1:5030", padTo: 100 });
      const one = await runCli(ctx, ["clean", "-a", "-y"], { home });
      const quiet = writeWorkspace(home, { key: "http://127.0.0.1:5031", backendUrl: "http://127.0.0.1:5031", padTo: 100 });
      const quietRun = await runCli(ctx, ["-q", "clean", "--all", "--yes"], { home });
      observe(ctx, "nothing left, one left, quiet", { again, one, quietRun }, [
        ctx.equal("nothing to remove", [again.code, again.stderr], [0, "ℹ No workspaces found\n– Skipped ~/.antelopejs/dms-frontend/foreign (not a workspace)\n"]),
        ctx.equal("a single workspace is singular, -a -y are --all --yes", [one.code, existsSync(alone.dir), one.stderr.split("\n")[0]], [0, false, "✔ Removed 1 workspace · freed 100 B"]),
        ctx.equal("-q removes the same and prints nothing", [quietRun.code, existsSync(quiet.dir), quietRun.stderr], [0, false, ""]),
      ]);
    },
  },
];
