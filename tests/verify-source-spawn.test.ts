import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { it } from "node:test";
import { showPath } from "../src/output";
import { temporaryDirectory } from "./fixtures/temporary-directory.mts";
import { isTextList } from "./helpers/guards";

const ACTION = join(
  __dirname,
  "..",
  "src",
  "commands",
  "verify-source-action.ts",
);
const PROBE = join(__dirname, "fixtures", "spawn-probe.mjs");
const PROCESS_TIMEOUT_MS = 20_000;

/**
 * An inline caller of `runVerifySource` that evaluates at most twice: a copy
 * that finds itself at depth 2 exits instead of spawning, so a runner that
 * evaluates the caller's script again ends the chain there.
 */
function inlineCaller(layer: string): string {
  return `
    const depth = Number(process.env.SPAWN_PROBE_DEPTH ?? "0") + 1;
    process.stderr.write("spawn-probe:script " + depth + "\\n");
    if (depth >= 2) process.exit(0);
    process.env.SPAWN_PROBE_DEPTH = String(depth);
    require(${JSON.stringify(ACTION)})
      .runVerifySource({ layer: ${JSON.stringify(layer)} })
      .catch((error) => {
        process.stderr.write("spawn-probe:error " + error.message + "\\n");
      });
  `;
}

function parseFlags(line: string): string[] {
  const flags: unknown = JSON.parse(line);
  assert.ok(isTextList(flags), `a list of flags: ${line}`);
  return flags;
}

interface ProbedRun {
  /** The Node.js flags of each process started, the caller first. */
  starts: string[][];
  scripts: number;
  errors: string[];
}

/** Runs the inline caller given after `evalFlag`, or on stdin for `-`. */
function probe(
  evalFlag: string,
  layer: string,
  env: NodeJS.ProcessEnv = {},
): ProbedRun {
  const script = inlineCaller(layer);
  const stdin = evalFlag === "-";
  const run = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      PROBE,
      ...(stdin ? ["-"] : [evalFlag, script]),
    ],
    {
      input: stdin ? script : undefined,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: PROCESS_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const lines = run.stderr.split("\n");
  const values = (tag: string) =>
    lines
      .filter((line) => line.startsWith(`spawn-probe:${tag} `))
      .map((line) => line.slice(`spawn-probe:${tag} `.length));
  return {
    starts: values("start").map(parseFlags),
    scripts: values("script").length,
    errors: values("error"),
  };
}

for (const evalFlag of ["-e", "--eval", "-p", "--print", "-"]) {
  void it(`starts one runner, not the caller's script again, from node ${evalFlag}`, () => {
    const layer = temporaryDirectory("verify-source-spawn-");
    const run = probe(evalFlag, layer);
    assert.equal(run.scripts, 1, "the caller's script ran once");
    assert.equal(run.starts.length, 2, "the caller and one runner started");
    const runner = run.starts[1];
    assert.ok(runner !== undefined);
    assert.ok(runner.includes(PROBE), "the loader flags reached the runner");
    assert.deepEqual(
      runner.filter((flag) => /^(-e|-p|--eval|--print)/.test(flag)),
      [],
    );
    assert.deepEqual(run.errors, [`No frontend package in ${showPath(layer)}`]);
  });
}
