import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants, gunzipSync } from "node:zlib";
import { isRow, isText, listAt, numberAt, parseJson, rowAt } from "./json.mjs";
import { observe } from "./proxy-satellite.mjs";

/** @typedef {import("./control.d.ts").JourneyContext} Ctx */

const BUILD_TIMEOUT_MS = 400_000;
const COMPRESSIBLE = new Set([".css", ".html", ".js", ".json", ".svg"]);
const MINIMUM = 1024;
const BIG_FILE_BYTES = 5_000_000;

/**
 * @param {string} directory A directory
 * @returns {string[]} Every file below it
 */
function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * @param {unknown} value A JSON value
 * @returns {string[]} Every non-empty string leaf in it
 */
function filledStrings(value) {
  if (isText(value)) return value === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap(filledStrings);
  if (isRow(value)) return Object.values(value).flatMap(filledStrings);
  return [];
}

/**
 * @param {Ctx} ctx The journey
 * @param {string} target The workspace to build into
 * @returns {Promise<string>} The build's output
 */
async function buildWithoutVariables(ctx, target) {
  const state = ctx.state;
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(DMS_|ANTELOPEJS_|PORT$|HOST$|NODE_ENV$)/.test(name)) env[name] = value;
  }
  Object.assign(env, {
    HOME: state.home,
    CI: "1",
    NO_COLOR: "1",
    AJS_NO_UPDATE_CHECK: "1",
    NO_UPDATE_NOTIFIER: "1",
    npm_config_cache: join(cache, "dms-control", "npm"),
    npm_config_store_dir: join(cache, "dms-control", "pnpm-store"),
  });
  const logFile = join(state.dir, "satellites", "build.log");
  const out = openSync(logFile, "w");
  const child = spawn("sh", ["-c", 'umask 022; exec "$0" "$@"', process.execPath, join(state.renderer ?? "", "dist/index.js"), "build", "-e", "docs", "--workspace", target], { cwd: state.runPlayground, env, stdio: ["ignore", out, out] });
  closeSync(out);
  /** @type {number | string | null} */
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve("timeout");
    }, BUILD_TIMEOUT_MS);
    child.once("exit", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  const log = readFileSync(logFile, "utf8");
  observe(ctx, "the build runs with no variable at all", { code, tail: log.slice(-1200) }, [
    ctx.equal("it exits with 0", code, 0),
    ctx.holds("it says where it wrote the build", /Built the production frontend → /.test(log), log.slice(-300)),
    ctx.holds("it names the command to run next", /ajs dms start -b <backend>/.test(log), log.slice(-200)),
  ], { critical: true });
  return log;
}

/**
 * @param {string} client The built client folder
 * @returns {{ files: string[], missing: string[], mismatched: string[], stray: string[] }} What the compression step left
 */
function compressionOutcome(client) {
  /** @type {string[]} */
  /** @type {string[]} */
  /** @type {string[]} */
  const files = walk(client);
  const missing = [];
  const mismatched = [];
  const stray = [];
  for (const file of files) {
    if (file.endsWith(".br") || file.endsWith(".gz")) {
      if (!existsSync(file.replace(/\.(br|gz)$/, ""))) stray.push(file);
      continue;
    }
    const expected = COMPRESSIBLE.has(extname(file)) && statSync(file).size >= MINIMUM;
    const hasBoth = existsSync(`${file}.br`) && existsSync(`${file}.gz`);
    const hasAny = existsSync(`${file}.br`) || existsSync(`${file}.gz`);
    if (expected && !hasBoth) missing.push(file);
    if (!expected && hasAny) stray.push(file);
    if (expected && hasBoth) {
      const content = readFileSync(file);
      if (!brotliDecompressSync(readFileSync(`${file}.br`)).equals(content) || !gunzipSync(readFileSync(`${file}.gz`)).equals(content)) mismatched.push(file);
    }
  }
  return { files, missing, mismatched, stray };
}

/**
 * @param {Ctx} ctx The journey
 * @param {string} client The built client folder
 */
function compressionChecks(ctx, client) {
  const { files, missing, mismatched, stray } = compressionOutcome(client);
  const boundary = files.filter((file) => /\.(css|js|json|svg|html)$/.test(file) && statSync(file).size >= MINIMUM).length;
  observe(ctx, "assets are pre-compressed", { files: files.length, boundary, missing: missing.slice(0, 5), mismatched: mismatched.slice(0, 5), stray: stray.slice(0, 5) }, [
    ctx.holds("the build has compressible files", boundary > 100, boundary),
    ctx.equal("every css, html, js, json and svg of 1 KiB or more has a .br and a .gz", missing, []),
    ctx.equal("each decodes to the file", mismatched, []),
    ctx.equal("no other file has a variant, and no variant is orphaned", stray, []),
  ]);
}

/**
 * @param {Ctx} ctx The journey
 * @param {string} client The built client folder
 * @param {string} log The build's output
 */
function documentChecks(ctx, client, log) {
  const html = readFileSync(join(client, "index.html"), "utf8");
  const script = /<script[^>]*type="module"[^>]*>/.exec(html)?.[0] ?? "";
  const styleAt = html.search(/<link rel="stylesheet"/);
  const scriptAt = html.search(/<script[^>]*type="module"/);
  const entry = /src="\/(assets\/[^"]+)"/.exec(script)?.[1];
  const recorded = parseJson(readFileSync(join(client, ".vite", "entry-weight.json"), "utf8"));
  const recordedFiles = listAt(recorded, "files").filter(isText);
  const brotliOf = (/** @type {string} */ file) =>
    existsSync(join(client, `${file}.br`))
      ? statSync(join(client, `${file}.br`)).size
      : brotliCompressSync(readFileSync(join(client, file)), { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY } }).length;
  const entryBr = recordedFiles.reduce((total, file) => total + brotliOf(file), 0);
  const entryRaw = numberAt(recorded, "bytes") ?? 0;
  const summary = /Client entry (\d+) KB Brotli \((\d+) KB\)/.exec(log);
  const preloads = (html.match(/rel="modulepreload"/g) ?? []).length;
  const weighs = summary !== null && Math.abs(Number(summary[1]) - entryBr / 1024) <= 1 && Math.abs(Number(summary[2]) - entryRaw / 1024) <= 1;
  const entryNamed = entry !== undefined && recordedFiles.includes(entry);
  observe(ctx, "the built document and the entry", { script, styleAt, scriptAt, entry, entryBr, entryRaw, summary: summary?.[0], preloads }, [
    ctx.holds("the stylesheet comes before the entry script", styleAt >= 0 && scriptAt >= 0 && styleAt < scriptAt, `${styleAt} < ${scriptAt}`),
    ctx.holds("the entry script has a low fetch priority", script.includes('fetchpriority="low"'), script),
    ctx.holds("the entry script is among the files the build recorded for the entry", entryNamed, `${entry} in ${recordedFiles.join(", ")}`),
    ctx.holds("the build reports the entry's weight: the Brotli KB of the recorded files and the recorded bytes", weighs, `${summary?.[0]} against ${entryBr} and ${entryRaw} bytes`),
    ctx.holds("the entry is one file: the document preloads a handful of chunks, not dozens", preloads <= 10, preloads),
  ]);
}

/**
 * @param {Ctx} ctx The journey
 * @param {string} target The built workspace
 */
function secretChecks(ctx, target) {
  /** @type {unknown} */
  const options = parseJson(readFileSync(join(target, "generated-server-options.json"), "utf8"));
  const candidates = walk(target).filter((file) => !file.includes("node_modules") && statSync(file).size < BIG_FILE_BYTES);
  const holders = Object.values(ctx.state.secrets).filter((secret) => candidates.some((file) => readFileSync(file).includes(secret)));
  observe(ctx, "secrets stay out of a build that ships with its project", { options }, [
    ctx.equal("no private option value is written into the build", filledStrings(rowAt(options, "modules") ?? {}), []),
    ctx.equal("the build holds none of the run's secrets", holders, []),
  ]);
}

export const journeys = [
  {
    id: "static-files-build",
    title: "ajs dms build needs no secret and writes pre-compressed assets and a document that paints before it hydrates",
    entryPoint: "`ajs dms build --workspace <dir>` from the run's project with a bare environment and umask 022",
    onboard: false,
    async run(/** @type {Ctx} */ ctx) {
      const target = join(ctx.state.dir, "satellites", "build");
      rmSync(target, { recursive: true, force: true });
      mkdirSync(join(ctx.state.dir, "satellites"), { recursive: true });
      const log = await buildWithoutVariables(ctx, target);
      const client = join(target, "dist", "client");
      compressionChecks(ctx, client);
      documentChecks(ctx, client, log);
      secretChecks(ctx, target);
    },
  },
];
