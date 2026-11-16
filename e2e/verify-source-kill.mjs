import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cliEnvironment, cliScript, observe, scratch } from "./cli-run.mjs";
import { projectFolder, writeProject } from "./verify-source-fixtures.mjs";
import { standalone } from "./standalone.mjs";

/** @typedef {import("./cli-run.mjs").Context} Context */

const POLL_MS = 50;
const BUILD_WAIT_MS = 300_000;
const GONE_WITHIN_MS = 5_000;
const SAFETY_CAP = 200;
const BUILD_TOOL = /\b(vite|vue-tsc)\b/;
const LOCK_DIRECTORY = /^ajs-dms-verify-source(-\d+)?$/;

/**
 * @param {string} pid A process id under /proc
 * @param {string} file `cmdline` or `environ`
 * @returns {string[]} Its NUL-separated entries, none for a process that is gone or not readable
 */
function procEntries(pid, file) {
  try {
    return readFileSync(`/proc/${pid}/${file}`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {string} mark The `TMPDIR` the journey gave the run
 * @returns {Map<number, string>} Every live process whose environment holds that `TMPDIR`, with its command line
 */
function marked(mark) {
  /** @type {Map<number, string>} */
  const found = new Map();
  for (const pid of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    if (procEntries(pid, "environ").includes(`TMPDIR=${mark}`)) found.set(Number(pid), procEntries(pid, "cmdline").join(" "));
  }
  return found;
}

/**
 * @param {Map<number, number>} scans How many scans saw each process id run the verify-source runner
 * @returns {number} How many processes ran it in two scans or more: a child the runner forks shows the runner's command line until it execs
 */
function runnersIn(scans) {
  return [...scans.values()].filter((count) => count >= 2).length;
}

/**
 * @param {string} mark The `TMPDIR` the journey gave the run
 */
function killMarked(mark) {
  for (const pid of marked(mark).keys()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      continue;
    }
  }
}

/**
 * @param {string} tmp The run's temporary directory
 * @returns {string[]} What the run left in it but Node's compile cache and the lock directory, whose lock a killed run leaves for the next run to take over
 */
function leftovers(tmp) {
  return readdirSync(tmp).filter((name) => name !== "node-compile-cache" && !LOCK_DIRECTORY.test(name));
}

/**
 * Starts a verification, watches every process that carries its `TMPDIR`, SIGKILLs the started process once a build
 * tool runs, and watches the processes that remain for {@link GONE_WITHIN_MS}. A second runner, the start of a chain, or
 * more than {@link SAFETY_CAP} processes kill every process of the run at once.
 *
 * @param {Context} ctx The journey
 * @param {string} name A folder name
 * @param {(script: string) => string[]} argv The Node arguments that start the verification, given the CLI script
 * @returns {Promise<{ seen: string[], runners: number, building: boolean, runaway: boolean, remaining: string[], left: string[] }>} What ran and what stayed
 */
async function killMidBuild(ctx, name, argv) {
  if (process.platform !== "linux") throw new Error("the journey reads the run's processes under /proc, which only Linux has");
  const fixture = writeProject(projectFolder(ctx, name));
  const tmp = scratch(ctx, `tmp-${name}`);
  const child = spawn(process.execPath, argv(cliScript(ctx)), {
    cwd: fixture.project,
    env: cliEnvironment(ctx, ctx.state.home, { TMPDIR: tmp }),
    stdio: "ignore",
  });
  /** @type {Map<number, string>} */
  const seen = new Map();
  /** @type {Map<number, number>} */
  const runnerScans = new Map();
  const watch = () => {
    for (const [pid, command] of marked(tmp)) {
      seen.set(pid, command);
      if (command.includes("verify-source-runner")) runnerScans.set(pid, (runnerScans.get(pid) ?? 0) + 1);
    }
  };
  let building = false;
  let runaway = false;
  /** @type {string[]} */
  let remaining = [];
  try {
    const deadline = Date.now() + BUILD_WAIT_MS;
    while (Date.now() < deadline && child.exitCode === null) {
      watch();
      if (runnersIn(runnerScans) > 1 || seen.size > SAFETY_CAP) {
        runaway = true;
        killMarked(tmp);
        break;
      }
      if ([...seen.values()].some((command) => BUILD_TOOL.test(command))) {
        building = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    child.kill("SIGKILL");
    const gone = Date.now() + GONE_WITHIN_MS;
    remaining = [...marked(tmp).values()];
    while (remaining.length > 0 && Date.now() < gone) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      remaining = [...marked(tmp).values()];
    }
  } finally {
    child.kill("SIGKILL");
    killMarked(tmp);
  }
  return {
    seen: [...seen.values()],
    runners: runnersIn(runnerScans),
    building,
    runaway,
    remaining,
    left: leftovers(tmp),
  };
}

/**
 * @param {Context} ctx The journey
 * @param {string} label What the step verifies
 * @param {Awaited<ReturnType<typeof killMidBuild>>} outcome What ran and what stayed
 */
function verifyKilled(ctx, label, outcome) {
  observe(ctx, label, outcome, [
    ctx.equal("no runaway chain of processes", outcome.runaway, false),
    ctx.equal("the build reached vite or vue-tsc before the kill", outcome.building, true),
    ctx.equal("exactly one runner ever started", outcome.runners, 1),
    ctx.equal(`no process of the run, runner, pnpm, vite and vue-tsc included, within ${GONE_WITHIN_MS / 1000} s`, outcome.remaining, []),
    ctx.equal("no temporary workspace left", outcome.left, []),
  ]);
}

export const journeys = [
  {
    id: "verify-source-dies-with-a-killed-cli",
    title: "a verify-source run whose CLI, or whose node -e caller of runVerifySource, is killed with SIGKILL mid-build starts one runner and leaves no process and no workspace behind",
    entryPoint: "ajs dms verify-source, and node -e calling runVerifySource, each SIGKILLed once vite or vue-tsc runs",
    ...standalone,
    async run(/** @type {Context} */ ctx) {
      verifyKilled(ctx, "the CLI killed mid-build", await killMidBuild(ctx, "kill-cli", (script) => [script, "verify-source"]));
      const action = (/** @type {string} */ script) => join(script, "..", "commands", "verify-source-action.js");
      verifyKilled(
        ctx,
        "the node -e caller killed mid-build",
        await killMidBuild(ctx, "kill-eval", (script) => ["-e", `require(${JSON.stringify(action(script))}).runVerifySource({}).catch(() => process.exit(1))`]),
      );
    },
  },
];
