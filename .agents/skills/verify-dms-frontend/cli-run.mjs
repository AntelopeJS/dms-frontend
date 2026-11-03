/**
 * Runs the renderer checkout's CLI (`node <renderer>/dist/index.js`) the way a user's shell does:
 * a home and a working directory of the journey's own, the run's package caches, and nothing of the
 * process manager's environment.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, openSync, closeSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isText } from "./json.mjs";

export const CLI_TIMEOUT_MS = 180_000;
const POLL_MS = 100;
const STOP_TIMEOUT_MS = 15_000;
const created = new Set();
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");
const SCRUBBED = /^(DMS_|ANTELOPEJS_|AJS_|PORT$|HOST$|NODE_ENV$|CI$|NO_COLOR$|FORCE_COLOR$|NO_UPDATE_NOTIFIER$|MONGO_|NODE_OPTIONS$|TERM$)/;

/**
 * @typedef {import("./control.d.ts").JourneyContext} Context
 * @typedef {{ code: number | null, signal: string | null, stdout: string, stderr: string, ms: number, args: string[] }} CliResult
 * @typedef {{ cwd?: string, home?: string, env?: Record<string, string | undefined>, timeoutMs?: number, input?: string, umask?: string, script?: string }} CliOptions
 */

/**
 * @param {string} text Terminal text
 * @returns {string} The text without color escape sequences
 */
export function plain(text) {
  return text.replace(ANSI, "");
}

/**
 * @param {Context} ctx The journey
 * @param {string} name A folder name, unique within the journey
 * @returns {string} A directory under the run, empty on its first use in this process, which `down` removes
 */
export function scratch(ctx, name) {
  const dir = join(ctx.state.dir, "scratch", ctx.journey, name);
  if (!created.has(dir)) {
    rmSync(dir, { recursive: true, force: true });
    created.add(dir);
  }
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * @param {Context} ctx The journey
 * @returns {string} The renderer's CLI script
 */
export function cliScript(ctx) {
  return join(ctx.state.renderer, "dist", "index.js");
}

/**
 * The environment of a CLI process: the run's, minus the variables the commands read, with the
 * caches of the run and the quiet defaults CI sets. `extra` goes last; `undefined` removes a variable.
 *
 * @param {Context} ctx The journey
 * @param {string} home The home directory
 * @param {Record<string, string | undefined>} [extra] Variables to set or remove
 * @returns {NodeJS.ProcessEnv} The environment
 */
export function cliEnvironment(ctx, home, extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!SCRUBBED.test(name)) env[name] = value;
  }
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? home, ".cache");
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    CI: "1",
    NO_COLOR: "1",
    AJS_NO_UPDATE_CHECK: "1",
    NO_UPDATE_NOTIFIER: "1",
    COREPACK_HOME: process.env.COREPACK_HOME ?? join(cacheHome, "node", "corepack"),
    npm_config_cache: join(cacheHome, "dms-control", "npm"),
    npm_config_store_dir: join(cacheHome, "dms-control", "pnpm-store"),
  });
  for (const [name, value] of Object.entries(extra)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * Runs the CLI to its end.
 *
 * @param {Context} ctx The journey
 * @param {string[]} args The arguments after `ajs dms`
 * @param {CliOptions} [options] Where and how to run it
 * @returns {Promise<CliResult>} How it ended
 */
export function runCli(ctx, args, options = {}) {
  const home = options.home ?? scratch(ctx, "home");
  const cwd = options.cwd ?? scratch(ctx, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const script = options.script ?? cliScript(ctx);
    const program = options.umask ? "sh" : process.execPath;
    const programArgs = options.umask ? ["-c", `umask ${options.umask}; exec "$0" "$@"`, process.execPath, script, ...args] : [script, ...args];
    const child = spawn(program, programArgs, {
      cwd,
      env: cliEnvironment(ctx, home, options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (part) => {
      stdout += String(part);
    });
    child.stderr.on("data", (part) => {
      stderr += String(part);
    });
    child.stdin.end(options.input ?? "");
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ajs dms ${args.join(" ")} did not end within ${options.timeoutMs ?? CLI_TIMEOUT_MS} ms: ${stderr.slice(-400)}`));
    }, options.timeoutMs ?? CLI_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, ms: Date.now() - startedAt, args });
    });
  });
}

/**
 * Runs the CLI under a pseudo terminal (`script`), so stdout and stderr are a terminal.
 *
 * @param {Context} ctx The journey
 * @param {string[]} args The arguments after `ajs dms`
 * @param {CliOptions & { columns?: number, answer?: string, waitForPrompt?: string }} [options] Where and how to run it
 * @returns {Promise<CliResult>} How it ended; both streams are in `stdout`
 */
export function runCliOnTerminal(ctx, args, options = {}) {
  const home = options.home ?? scratch(ctx, "home");
  const cwd = options.cwd ?? scratch(ctx, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const quoted = [process.execPath, cliScript(ctx), ...args].map((part) => `'${part.replaceAll("'", "'\\''")}'`).join(" ");
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("script", ["-qec", `stty cols ${options.columns ?? 100}; exec ${quoted}`, "/dev/null"], {
      cwd,
      env: { ...cliEnvironment(ctx, home, options.env), TERM: options.env?.TERM ?? "xterm-256color" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let answered = false;
    const feed = () => {
      if (options.answer !== undefined && !answered && stdout.includes(options.waitForPrompt ?? "")) {
        answered = true;
        setTimeout(() => child.stdin.write(options.answer), 300);
      }
    };
    child.stdout.on("data", (part) => {
      stdout += String(part);
      feed();
    });
    child.stderr.on("data", (part) => {
      stdout += String(part);
      feed();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ajs dms ${args.join(" ")} on a terminal did not end: ${stdout.slice(-400)}`));
    }, options.timeoutMs ?? CLI_TIMEOUT_MS);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: stdout.replaceAll("\r\n", "\n"), stderr: "", ms: Date.now() - startedAt, args });
    });
    if (options.answer === undefined) child.stdin.end();
  });
}

/**
 * @typedef {object} RunningCli
 * @property {import("node:child_process").ChildProcess} child
 * @property {() => string} stdout
 * @property {() => string} stderr
 * @property {() => string} output Both streams, in the order of arrival
 * @property {Promise<{ code: number | null, signal: string | null }>} exited
 * @property {(pattern: string | RegExp, timeoutMs?: number) => Promise<string>} waitFor Resolves with the output once it matches; rejects when the process ends first
 * @property {(signal?: NodeJS.Signals) => Promise<{ code: number | null, signal: string | null }>} stop
 */

/**
 * Starts the CLI and leaves it running (a server).
 *
 * @param {Context} ctx The journey
 * @param {string[]} args The arguments after `ajs dms`
 * @param {CliOptions} [options] Where and how to run it
 * @returns {RunningCli} The running process
 */
export function startCli(ctx, args, options = {}) {
  const home = options.home ?? scratch(ctx, "home");
  const cwd = options.cwd ?? scratch(ctx, "cwd");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const child = spawn(process.execPath, [cliScript(ctx), ...args], {
    cwd,
    env: cliEnvironment(ctx, home, options.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  let both = "";
  child.stdout.on("data", (part) => {
    out += String(part);
    both += String(part);
  });
  child.stderr.on("data", (part) => {
    err += String(part);
    both += String(part);
  });
  /** @type {Promise<{ code: number | null, signal: string | null }>} */
  const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  let ended = false;
  void exited.then(() => {
    ended = true;
  });
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    output: () => both,
    exited,
    async waitFor(pattern, timeoutMs = CLI_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs;
      const matches = () => (pattern instanceof RegExp ? pattern.test(both) : both.includes(pattern));
      while (!matches()) {
        if (ended) throw new Error(`the process ended before printing ${pattern}: ${both.slice(-600)}`);
        if (Date.now() > deadline) throw new Error(`no ${pattern} within ${timeoutMs} ms: ${both.slice(-600)}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
      return both;
    },
    async stop(signal = "SIGINT") {
      if (!ended) child.kill(signal);
      const timer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
      const result = await exited;
      clearTimeout(timer);
      return result;
    },
  };
}

/**
 * @param {import("node:net").Server} server A listening server
 * @returns {number} The port it listens on
 */
export function listeningPort(server) {
  const address = server.address();
  return address === null || isText(address) ? 0 : address.port;
}

/**
 * @returns {Promise<number>} A free port from the kernel
 */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = listeningPort(probe);
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Holds a port, as another process would, until `release`.
 *
 * @param {string} [host] The address to bind
 * @returns {Promise<{ port: number, release: () => Promise<void> }>} The holder
 */
export function holdPort(host = "0.0.0.0") {
  return new Promise((resolve, reject) => {
    const holder = createServer((socket) => socket.destroy());
    holder.on("error", reject);
    holder.listen(0, host, () => {
      const port = listeningPort(holder);
      resolve({ port, release: () => new Promise((done) => holder.close(() => done(undefined))) });
    });
  });
}

/**
 * Records one step with the commands it ran and what they printed next to its checks.
 *
 * @param {Context} ctx The journey
 * @param {string} label What the step verifies
 * @param {Record<string, unknown>} observed What was observed, by name
 * @param {import("./control.d.ts").Check[]} checks The checks
 * @param {{ critical?: boolean }} [options] Whether a failure ends the journey
 * @returns {boolean} Whether every check passed
 */
export function observe(ctx, label, observed, checks, options) {
  const folder = ctx.step(label);
  writeFileSync(join(folder, "observed.json"), `${JSON.stringify(observed, null, 2)}\n`);
  return ctx.record(folder, checks, options);
}

/**
 * A text comparison whose detail shows both texts.
 *
 * @param {Context} ctx The journey
 * @param {string} name What is compared
 * @param {string} actual The text found
 * @param {string} expected The text wanted
 * @returns {import("./control.d.ts").Check} The check
 */
export function sameText(ctx, name, actual, expected) {
  return ctx.holds(name, actual === expected, actual === expected ? "equal" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * @param {string} file A file
 * @returns {string} Its text
 */
export function readText(file) {
  return readFileSync(file, "utf8");
}

/**
 * Creates an empty file path holder for a log.
 *
 * @param {string} file A file to create
 * @returns {number} Its descriptor, to close
 */
export function openLog(file) {
  return openSync(file, "w");
}

export { closeSync };
