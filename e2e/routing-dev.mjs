import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sleep } from "./proxy-satellite.mjs";

const READY_TIMEOUT_MS = 240_000;
const STOP_TIMEOUT_MS = 15_000;

/**
 * Starts `ajs dms dev` against the run's backend, in the run's home so its
 * workspace is the run's own.
 *
 * @param {import("./control.d.ts").JourneyContext} ctx The journey
 * @param {Record<string, string>} [extra] More variables
 * @param {string} [shell] A shell command to run first, such as `umask 022`
 * @returns {Promise<{ url: string, port: number, workspace: string, log: () => string, stop: () => Promise<void> }>} The running server
 */
export async function startDev(ctx, extra = {}, shell = "") {
  const state = ctx.state;
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!/^(DMS_|ANTELOPEJS_|PORT$|HOST$|NODE_ENV$)/.test(name)) env[name] = value;
  }
  Object.assign(env, {
    HOME: state.home,
    USERPROFILE: state.home,
    CI: "1",
    NO_COLOR: "1",
    AJS_NO_UPDATE_CHECK: "1",
    NO_UPDATE_NOTIFIER: "1",
    npm_config_cache: join(cache, "dms-control", "npm"),
    npm_config_store_dir: join(cache, "dms-control", "pnpm-store"),
    DMS_API_BASE_URL: state.apiUrl,
    ...state.secrets,
    ...extra,
  });
  const file = join(state.dir, "satellites", `dev-${ctx.journey}.log`);
  const out = openSync(file, "w");
  const dev = [join(state.renderer, "dist/index.js"), "dev", "-e", "docs", "-b", state.apiUrl, "-p", "0"];
  const child = (shell ? spawn("sh", ["-c", `${shell}; exec "$0" "$@"`, process.execPath, ...dev], {
    cwd: state.runPlayground,
    env,
    stdio: ["ignore", out, out],
  }) : spawn(process.execPath, dev, {
    cwd: state.runPlayground,
    env,
    stdio: ["ignore", out, out],
  }));
  closeSync(out);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const log = () => readFileSync(file, "utf8");
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const text = log();
    if (text.includes("Routing:") && /Local:\s+http:\/\/localhost:\d+\//.test(text)) break;
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGTERM");
      throw new Error(`the dev server did not start: ${text.slice(-800)}`);
    }
    await sleep(500);
  }
  await sleep(500);
  const text = log();
  const port = Number(/Local:\s+http:\/\/localhost:(\d+)\//.exec(text)?.[1]);
  const workspace = /Workspace:\s+~\/(\S+)/.exec(text)?.[1] ?? "";
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    workspace: join(state.home, workspace),
    log,
    async stop() {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(STOP_TIMEOUT_MS)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
  };
}
