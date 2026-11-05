import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { at, isNumber, isRow, isText, listAt, numberAt, rowAt } from "./json.mjs";
import { readJson } from "./cli-json.mjs";
import { startCliBackend } from "./cli-backend.mjs";
import { observe, runCli, scratch } from "./cli-run.mjs";
import { serve, snapshot, whileServing } from "./build-server.mjs";
import { humanSize } from "./workspace-fixtures.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const BUILD_TIMEOUT_MS = 900_000;
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".svg"]);
const STEPS = ["✔ Built the client bundle", "✔ Compressed the client assets", "✔ Built the SSR bundle", "✔ Built the e-mail bundle", "✔ Built the server modules"];

/**
 * @param {string} dir A directory
 * @returns {string[]} Every file below it
 */
function filesBelow(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesBelow(join(dir, entry.name)) : [join(dir, entry.name)]));
}

/**
 * @param {string} text Build output
 * @returns {string[]} Its lines without the timings
 */
export function untimed(text) {
  return text.split("\n").map((line) => line.replace(/ · (\d+m )?\d+(\.\d+)?m?s$/, "").replace(/ (\d+m )?\d+(\.\d+)?m?s$/, "").replace(/Installed \d+ packages/, "Installed <n> packages"));
}

/**
 * @param {import("./cli-run.mjs").Context} ctx The journey
 * @param {string} workspace The workspace to build into
 * @param {string[]} [args] More arguments
 * @param {Record<string, string | undefined>} [env] More variables
 * @returns {Promise<import("./cli-run.mjs").CliResult>} The build
 */
export function build(ctx, workspace, args = [], env = {}) {
  return runCli(ctx, ["build", "-e", "docs", "--workspace", workspace, ...args], { cwd: ctx.state.runPlayground, home: ctx.state.home, env, timeoutMs: BUILD_TIMEOUT_MS, umask: "022" });
}

/**
 * @param {unknown} value A parsed JSON value
 * @returns {unknown[]} Every scalar below it
 */
function leavesOf(value) {
  if (Array.isArray(value)) return value.flatMap(leavesOf);
  return isRow(value) ? Object.values(value).flatMap(leavesOf) : [value];
}

/**
 * The entry weight the way the page describes it, from the file the client build records.
 *
 * @param {string} workspace A built workspace
 * @returns {{ brotli: number, bytes: number, shares: { owner: string, bytes: number, brotli: number }[] }} What the report must say
 */
function expectedEntryWeight(workspace) {
  const recorded = readJson(join(workspace, "dist", "client", ".vite", "entry-weight.json"));
  const total = numberAt(recorded, "bytes") ?? 0;
  const brotli = listAt(recorded, "files")
    .filter(isText)
    .reduce((sum, file) => {
      const path = join(workspace, "dist", "client", file);
      return sum + (existsSync(`${path}.br`) ? statSync(`${path}.br`).size : brotliCompressSync(readFileSync(path), { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }).length);
    }, 0);
  const ratio = total ? brotli / total : 0;
  const owners = rowAt(recorded, "owners") ?? {};
  const shares = Object.entries(owners)
    .filter((entry) => isNumber(entry[1]))
    .map(([owner, bytes]) => ({ owner, bytes: Number(bytes), brotli: Math.round(Number(bytes) * ratio) }))
    .sort((left, right) => right.bytes - left.bytes);
  return { brotli, bytes: total, shares };
}

export const journeys = [
  {
    id: "build-output",
    title: "build writes the client, compressed, SSR, e-mail and server bundles in the order the page shows, reports the client entry, keeps no secret, and start serves the result",
    entryPoint: "ajs dms build --workspace <dir> from the run's playground, then ajs dms start --workspace <dir>",
    async run(/** @type {Context} */ ctx) {
      const workspace = join(scratch(ctx, "built"), "workspace");
      const first = await build(ctx, workspace);
      const lines = untimed(first.stderr);
      const warning = lines.findIndex((line) => line.startsWith("▲ "));
      const entry = lines.findIndex((line) => line.startsWith("ℹ Client entry"));
      const weight = expectedEntryWeight(workspace);
      observe(ctx, "the first build", first, [
        ctx.equal("exit 0, nothing on stdout", [first.code, first.stdout], [0, ""]),
        ctx.equal("header: the project and the environment", lines[0], "ajs dms build  . · docs"),
        ctx.equal("a new workspace is generated, then its dependencies installed", lines.slice(1, 3), ["✔ Workspace generated", "✔ Installed <n> packages"]),
        ctx.equal("then the build starts in the workspace", lines.slice(3, 5), ["ℹ Building for production", `  Workspace  ${workspace}`]),
        ctx.equal("the five steps, in this order", lines.slice(5, 10), STEPS),
        ctx.holds("Vite's warnings are counted and, piped, listed in full", /^▲ \d+ Vite warnings?$/.test(lines[warning] ?? "") && lines[warning + 1]?.startsWith("  "), lines[warning]),
        ctx.equal("the client entry report: its weight, then the share of the shared code and of each module, largest first", lines.slice(entry, entry + 1 + weight.shares.length), [
          `ℹ Client entry ${humanSize(weight.brotli)} Brotli (${humanSize(weight.bytes)}), loaded first by every page`,
          ...weight.shares.map((share) => `  ${share.owner}  ${humanSize(share.brotli)} (${humanSize(share.bytes)})`),
        ]),
        ctx.equal("the shared code is the largest owner, and the shares add up to the entry", [weight.shares[0].owner, Math.abs(weight.shares.reduce((sum, share) => sum + share.brotli, 0) - weight.brotli) <= weight.shares.length], ["shared", true]),
        ctx.equal("no module reaches the 50 KB default threshold, so no module warning", lines.some((line) => line.includes("adds ") && line.includes("Brotli to the client entry")), false),
        ctx.equal("the summary names the artifact and the next step with the same workspace", lines.slice(entry + 1 + weight.shares.length).filter(Boolean), [
          `Built the production frontend → ${workspace}/dist`,
          "Next steps",
          `  ajs dms start -b <backend> --workspace ${workspace}  from the project, with DMS_SESSION_SECRET, the server's secrets and the deployment's variables in its environment`,
        ]),
      ]);

      const dist = join(workspace, "dist");
      const client = filesBelow(join(dist, "client"));
      const compressible = client.filter((file) => COMPRESSIBLE.has(extname(file)));
      const problems = [];
      for (const file of compressible) {
        const size = statSync(file).size;
        const hasBrotli = existsSync(`${file}.br`);
        const hasGzip = existsSync(`${file}.gz`);
        if (size >= 1024) {
          if (!hasBrotli || !hasGzip) problems.push(`${file}: missing copy`);
          else if (!brotliDecompressSync(readFileSync(`${file}.br`)).equals(readFileSync(file)) || !gunzipSync(readFileSync(`${file}.gz`)).equals(readFileSync(file))) problems.push(`${file}: copy differs`);
        } else if (hasBrotli || hasGzip) problems.push(`${file}: compressed although under 1 KiB`);
      }
      const assets = client.filter((file) => file.includes(`${join("dist", "client", "assets")}/`) && extname(file) === ".js");
      const optionsFile = join(workspace, "generated-server-options.json");
      const options = readJson(optionsFile);
      /**
       * @param {string} file A file of dist
       */
      const publicFiles = existsSync(join(workspace, "public")) ? filesBelow(join(workspace, "public")).map((file) => file.slice(join(workspace, "public").length)) : [];
      const copied = (file) => publicFiles.some((relative) => file.endsWith(relative));
      const unreadable = filesBelow(dist).filter((file) => !copied(file) && (statSync(file).mode & 0o004) === 0);
      observe(ctx, "what the build wrote", { problems, assets: assets.length }, [
        ctx.equal("the client application: an index.html and hashed assets", [existsSync(join(dist, "client", "index.html")), assets.length > 0, assets.every((file) => /-[\w-]{6,}\.js$/.test(file))], [true, true, true]),
        ctx.equal("every compressible client file of 1 KiB or more has a .br and a .gz copy that decompresses to it; smaller ones have none", problems, []),
        ctx.equal("the SSR bundle, the e-mail renderer with its catalogs, and the server modules", [readdirSync(join(dist, "ssr")).length > 0, readdirSync(join(dist, "server", "locales")).some((name) => name.endsWith(".json")), existsSync(join(dist, "server-modules", "server-modules.generated.js"))], [true, true, true]),
        ctx.equal("the recorded entry weight exists", existsSync(join(dist, "client", ".vite", "entry-weight.json")), true),
        ctx.equal("the build keeps no secret: every private option is empty", leavesOf(at(options, "modules")).every((leaf) => leaf === ""), true),
        ctx.equal("the options file is readable by other users (0644)", (statSync(optionsFile).mode & 0o777).toString(8), "644"),
        ctx.equal("every file the build generates in dist is readable by other users (files copied from public/ keep their source's mode)", unreadable, []),
        ctx.equal("a workspace the caller named is created with the default permissions, not 0700", (statSync(workspace).mode & 0o777).toString(8), "755"),
        ctx.equal("start can serve it: the files it needs are there", [existsSync(join(workspace, "server.mjs")), existsSync(join(dist, "client", "index.html"))], [true, true]),
      ]);

      const backend = await startCliBackend();
      try {
        const before = snapshot(workspace);
        const byFlag = await serve(ctx, backend.url, { project: true, args: ["--workspace", workspace] });
        const block = byFlag.output();
        await whileServing(byFlag, async () => {
          const answered = await fetch(`${byFlag.local}dms-preview`, { redirect: "manual" });
          observe(ctx, "start --workspace", { block }, [
            ctx.equal("the ready block names the workspace given", /^ {5}Workspace: (.*)$/m.exec(block)?.[1], workspace),
            ctx.equal("the server answers", answered.status < 500, true),
          ]);
        });
        const byEnv = await serve(ctx, backend.url, { env: { DMS_WORKSPACE_DIR: workspace } });
        const envBlock = byEnv.output();
        await byEnv.stop();
        observe(ctx, "DMS_WORKSPACE_DIR", { envBlock }, [
          ctx.equal("it is --workspace", /^ {5}Workspace: (.*)$/m.exec(envBlock)?.[1], workspace),
          ctx.equal("start wrote nothing into the workspace", snapshot(workspace), before),
        ]);
      } finally {
        await backend.close();
      }

      const second = await build(ctx, workspace, [], { DMS_ENTRY_WEIGHT_WARNING: String(Math.floor((weight.shares[1].brotli + weight.shares[2].brotli) / 2 / 1024)) });
      const threshold = Math.floor((weight.shares[1].brotli + weight.shares[2].brotli) / 2 / 1024);
      const secondLines = untimed(second.stderr);
      const modules = weight.shares.filter((share) => share.owner !== "shared" && share.owner !== "translations");
      const heavy = modules.filter((share) => share.brotli > threshold * 1024);
      const light = modules.filter((share) => share.brotli <= threshold * 1024);
      observe(ctx, "a second build with a lower threshold", { second, threshold }, [
        ctx.equal("exit 0, and the dependencies are not installed again", [second.code, secondLines.includes("✔ Installed <n> packages"), secondLines[1]], [0, false, "✔ Workspace ready"]),
        ctx.equal("the module above the threshold is warned about", secondLines.filter((line) => line.startsWith("▲ ") && line.includes("adds ")), heavy.map((share) => `▲ ${share.owner} adds ${humanSize(share.brotli)} Brotli to the client entry`)),
        ctx.equal("no module under it is", light.some((share) => secondLines.some((line) => line.startsWith(`▲ ${share.owner} adds`))), false),
        ctx.equal("the explanation and the threshold close the warnings", secondLines.filter((line) => line.startsWith("  The threshold") || line.startsWith("  What a module")), [
          "  What a module's dms.frontend.ts and its plugins import is loaded by every page: render a component they only show on some pages by its registered name or with defineAsyncComponent",
          `  The threshold is ${threshold} KB (DMS_ENTRY_WEIGHT_WARNING, in KB; 0 turns the warning off)`,
        ]),
        ctx.equal("the build still succeeds", secondLines.at(-5)?.startsWith("Built the production frontend") || secondLines.some((line) => line.startsWith("Built the production frontend")), true),
      ]);

      rmSync(join(workspace, "node_modules", "vue"), { force: true });
      const third = await build(ctx, workspace, ["--force"], { DMS_ENTRY_WEIGHT_WARNING: "0" });
      const restored = existsSync(join(workspace, "node_modules", "vue"));
      const thirdLines = untimed(third.stderr);
      observe(ctx, "--force with the warning turned off", { third }, [
        ctx.equal("--force runs the dependency install again, which finds nothing to change", [third.code, thirdLines[2]], [0, "✔ Dependencies up to date"]),
        ctx.equal("it repaired a dependency link removed beforehand", restored, true),
        ctx.equal("0 turns the module warnings off but the report stays", [thirdLines.some((line) => line.includes("Brotli to the client entry")), thirdLines.some((line) => line.startsWith("ℹ Client entry"))], [false, true]),
      ]);
    },
  },
];
