import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isObjectLike } from "../../src/internal/guards";
import { readText } from "../helpers/files";
import { isText } from "../helpers/guards";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** The compiled CLI the runs spawn: build before running these suites. */
export const CLI = join(REPOSITORY, "dist/index.js");
const FAKE_PNPM = join(REPOSITORY, "tests/fixtures/fake-pnpm.mjs");
const SESSION_SECRET = "framed-output-test-session-secret-0123";

/** One call the CLI made to the fake pnpm. */
export interface PnpmCall {
  args: string[];
  env: { updateNotifier?: string; viteLogLevel?: string };
}

function isPnpmCall(value: unknown): value is PnpmCall {
  return (
    isObjectLike(value) &&
    "args" in value &&
    Array.isArray(value.args) &&
    value.args.every(isText) &&
    "env" in value &&
    isObjectLike(value.env) &&
    (!("updateNotifier" in value.env) ||
      value.env.updateNotifier === undefined ||
      isText(value.env.updateNotifier)) &&
    (!("viteLogLevel" in value.env) ||
      value.env.viteLogLevel === undefined ||
      isText(value.env.viteLogLevel))
  );
}

function parsePnpmCall(line: string): PnpmCall {
  const call: unknown = JSON.parse(line);
  assert.ok(isPnpmCall(call), `a pnpm call, got ${line}`);
  return call;
}

/** A finished run, with the pnpm calls it made. */
export interface FakePnpmRun {
  code: number | null;
  stdout: string;
  stderr: string;
  calls: PnpmCall[];
  /** Both the cwd and HOME of the run. */
  sandbox: string;
}

/** How a run is set up. */
export interface FakePnpmRunOptions {
  /** What the fake pnpm does: `success`, `install-fails` or `ssr-fails`. */
  scenario?: string;
  /** Prepares a new sandbox before the run. */
  setUp?: (sandbox: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Runs again in this sandbox, as it is, instead of a new one. */
  sandbox?: string;
}

/**
 * The compiled CLI with a fake `pnpm` first on PATH, each run in a sandbox
 * under one scratch directory.
 */
export class FakePnpmCli {
  /** The directory every sandbox of this CLI lives under. */
  readonly scratch: string;
  private readonly bin: string;

  constructor(prefix: string) {
    assert.ok(existsSync(CLI), `${CLI} is missing: run pnpm build first`);
    this.scratch = mkdtempSync(join(tmpdir(), prefix));
    this.bin = join(this.scratch, "bin");
    mkdirSync(this.bin);
    const pnpm = join(this.bin, "pnpm");
    writeFileSync(
      pnpm,
      `#!/bin/sh\nexec "${process.execPath}" "${FAKE_PNPM}" "$@"\n`,
    );
    chmodSync(pnpm, 0o755);
  }

  /** Runs `ajs dms <args>` and resolves once it exits. */
  run(args: string[], options: FakePnpmRunOptions = {}): Promise<FakePnpmRun> {
    const sandbox = options.sandbox ?? mkdtempSync(join(this.scratch, "run-"));
    if (!options.sandbox) options.setUp?.(sandbox);
    const log = join(sandbox, "pnpm-calls.jsonl");
    rmSync(log, { force: true });
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${this.bin}:${process.env.PATH}`,
      HOME: sandbox,
      USERPROFILE: sandbox,
      NO_COLOR: "1",
      NO_UPDATE_NOTIFIER: "1",
      DMS_API_BASE_URL: "",
      DMS_SESSION_SECRET: SESSION_SECRET,
      FAKE_PNPM_SCENARIO: options.scenario ?? "success",
      FAKE_PNPM_LOG: log,
      ...options.env,
    };
    delete env.ANTELOPEJS_VERBOSE;
    delete env.ANTELOPEJS_QUIET;
    delete env.FORCE_COLOR;
    const cli = spawn(process.execPath, [CLI, ...args], {
      cwd: sandbox,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    cli.stdout.on("data", (chunk) => (stdout += chunk));
    cli.stderr.on("data", (chunk) => (stderr += chunk));
    return new Promise((settle) =>
      cli.on("close", (code) => {
        const calls = existsSync(log)
          ? readText(log).trim().split("\n").map(parsePnpmCall)
          : [];
        settle({ code, stdout, stderr, calls, sandbox });
      }),
    );
  }

  /** Removes every sandbox. */
  dispose(): void {
    rmSync(this.scratch, { recursive: true, force: true });
  }
}

/** A frontend module source with one component. */
export function writeLayer(dir: string): void {
  mkdirSync(join(dir, "app/components"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "framed-layer" }),
  );
  writeFileSync(join(dir, "app/components/Callout.vue"), "<template />\n");
}

/** The module the fixtures declare, as a manifest lists it. */
export const MODULE = {
  name: "framed-layer",
  priority: 0,
  renderer: { name: "vue", version: "3" },
};

/**
 * A project whose one module declares its frontend, `<sandbox>/frontend-vue`,
 * with `dmsFrontend`: what `build` reads, without any backend.
 */
export function projectHome(sandbox: string): void {
  writeLayer(join(sandbox, "frontend-vue"));
  writeFileSync(
    join(sandbox, "package.json"),
    JSON.stringify({ name: "framed-project", dmsFrontend: "frontend.js" }),
  );
  writeFileSync(
    join(sandbox, "frontend.js"),
    `exports.frontendModule = () => ({
  name: ${JSON.stringify(MODULE.name)},
  sourcePath: require("node:path").join(__dirname, "frontend-vue"),
  renderer: { name: "vue", version: "3" },
});\n`,
  );
  writeFileSync(
    join(sandbox, "antelope.config.ts"),
    `export default { name: "framed", modules: { framed: { source: { type: "local", path: "." } } } };\n`,
  );
}
