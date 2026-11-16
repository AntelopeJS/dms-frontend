/**
 * `ajs dms start` against the run's built workspace and a backend of the journey's own.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { freePort, scratch, startCli } from "./cli-run.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

export const SESSION_SECRET = "session-secret-of-the-verify-run-0123456789";
export const RENDER_SECRET = "render-secret";
export const RELAY_SECRET = "relay-secret";
export const BOOTSTRAP_SECRET = "bootstrap-secret";

/**
 * @typedef {import("./cli-run.mjs").RunningCli & { port: number, url: string, local: string }} Served
 */

/**
 * @param {{ state: { runPlayground: string } }} ctx The journey
 * @returns {string} The workspace `up` built for the run's playground
 */
export function builtWorkspace(ctx) {
  return join(ctx.state.runPlayground, ".dms-frontend");
}

/**
 * Starts `ajs dms start` and waits until it printed its Routing block.
 *
 * @param {import("./cli-run.mjs").Context} ctx The journey
 * @param {string} backendUrl The backend to serve
 * @param {{ port?: number | null, args?: string[], env?: Record<string, string | undefined>, cwd?: string, home?: string, withoutSecrets?: boolean, ready?: string | RegExp, project?: boolean }} [options] Variations; `port: null` leaves `-p` out
 * @returns {Promise<Served>} The running server
 */
export async function serve(ctx, backendUrl, options = {}) {
  const port = options.port === null ? 0 : (options.port ?? (await freePort()));
  const args = ["start", "-e", "docs", "-b", backendUrl, ...(options.port === null ? [] : ["-p", String(port)]), ...(options.project === false ? [] : ["--project", ctx.state.runPlayground]), ...(options.args ?? [])];
  const secrets = options.withoutSecrets
    ? {}
    : { DMS_SESSION_SECRET: SESSION_SECRET, DMS_HTML_RENDER_SECRET: RENDER_SECRET, DMS_OAUTH_RELAY_SECRET: RELAY_SECRET, DMS_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET };
  const cli = startCli(ctx, args, { cwd: options.cwd ?? scratch(ctx, "cwd"), home: options.home ?? ctx.state.home, env: { ...secrets, ...options.env } });
  try {
    await cli.waitFor(options.ready ?? "Routing:", 90_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
  } catch (error) {
    await cli.stop("SIGKILL");
    throw error;
  }
  const match = /Local:\s+(http:\/\/\S+)/.exec(cli.output());
  const local = match ? match[1] : "";
  return { ...cli, port: Number(new URL(local || "http://x:0").port), url: local, local };
}

/**
 * Runs `body` with a running server and always stops it.
 *
 * @template T
 * @param {Served} server The server
 * @param {(server: Served) => Promise<T>} body What to do with it
 * @returns {Promise<T>} What `body` returns
 */
export async function whileServing(server, body) {
  try {
    return await body(server);
  } finally {
    await server.stop("SIGINT");
  }
}

/**
 * The files below a directory, with size and modification time, for comparing before and after;
 * `node_modules` is counted by its top-level entries only.
 *
 * @param {string} dir A directory
 * @param {string} [prefix] Path prefix of the entries
 * @returns {string[]} One line per file or directory, sorted
 */
export function snapshot(dir, prefix = "") {
  /** @type {string[]} */
  const lines = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stats = lstatSync(path);
    lines.push(`${prefix}${entry.name} ${stats.size} ${stats.mtimeMs}`);
    if (entry.isDirectory() && entry.name !== "node_modules") lines.push(...snapshot(path, `${prefix}${entry.name}/`));
  }
  return lines.sort();
}
