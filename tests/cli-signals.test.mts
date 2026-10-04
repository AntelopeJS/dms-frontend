import * as assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPOSITORY, "dist/index.js");
const FIXTURES = join(REPOSITORY, "tests/fixtures");
const PROCESS_TREE = join(FIXTURES, "process-tree.mjs");
const SESSION_SECRET = "signals-test-session-secret-0123456789";
const TERMINAL_STDERR = join(FIXTURES, "terminal-stderr.mjs");
const { version } = JSON.parse(
  readFileSync(join(REPOSITORY, "package.json"), "utf8"),
);

let scratch: string;

/** Every pid a test saw, killed after the suite so a failure leaks nothing. */
const seen: number[] = [];

interface Exit {
  code: number | null;
  signal: string | null;
}

interface Run {
  /** The CLI's own pid, which leads its process group when `ownGroup` is set. */
  pid: number;
  exited: Promise<Exit>;
  output: () => string;
  /** "<child pid> <grandchild pid>", once the tree is fully up. */
  tree: Promise<[number, number]>;
}

interface StartOptions {
  args: string[];
  env?: Record<string, string>;
  /**
   * Run the CLI in a process group of its own, so a signal sent to that
   * group reaches it the way a terminal's Ctrl+C reaches the foreground job.
   */
  ownGroup?: boolean;
  /** Entry point; defaults to the built CLI. */
  entry?: string[];
}

function startCli({
  args,
  env = {},
  ownGroup = false,
  entry = [CLI],
}: StartOptions): Run {
  const sandbox = mkdtempSync(join(scratch, "run-"));
  const pidFile = join(sandbox, "tree.pid");
  const home = env.HOME ?? sandbox;
  const cli = spawn(process.execPath, [...entry, ...args], {
    cwd: sandbox,
    detached: ownGroup,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: home,
      NO_UPDATE_NOTIFIER: "1",
      DMS_API_BASE_URL: "",
      DMS_TEST_PID_FILE: pidFile,
      ...env,
    },
  });
  let output = "";
  cli.stdout.on("data", (chunk) => (output += chunk));
  cli.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<Exit>((settle) =>
    cli.on("exit", (code, signal) => settle({ code, signal })),
  );
  const tree = waitFor(
    () => {
      const pids = readFileSync(pidFile, "utf8").trim().split(" ").map(Number);
      if (pids.length !== 2 || !pids.every((pid) => pid > 0)) return undefined;
      seen.push(...pids);
      return pids as [number, number];
    },
    () => output,
  );
  return { pid: cli.pid!, exited, output: () => output, tree };
}

async function waitFor<T>(
  probe: () => T | undefined,
  context: () => string = () => "",
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const value = probe();
      if (value !== undefined) return value;
    } catch {
      // Not ready yet.
    }
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for the process tree\n${context()}`);
    await new Promise((tick) => setTimeout(tick, 50));
  }
}

/** A zombie has already exited; it only waits for init to reap it. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
  } catch {
    return true;
  }
}

async function assertTreeGone(pids: number[]) {
  await waitFor(
    () => (pids.some(isAlive) ? undefined : true),
    () => `still running: ${pids.filter(isAlive).join(", ")}`,
    5000,
  );
}

/**
 * A home holding what `ajs dms build` leaves behind for `start`, with the
 * process-tree fixture standing in for the generated server.
 */
function builtHome(backendUrl: string): string {
  const home = mkdtempSync(join(scratch, "home-"));
  const workspace = join(
    home,
    ".antelopejs/dms-frontend",
    createHash("sha256").update(backendUrl).digest("hex"),
  );
  mkdirSync(join(workspace, "dist/client"), { recursive: true });
  writeFileSync(join(workspace, "dist/client/index.html"), "<html></html>");
  copyFileSync(PROCESS_TREE, join(workspace, "server.mjs"));
  return home;
}

/** Starts `start`, resolving once the CLI printed the server's ready block. */
async function startServer(backendUrl: string, ownGroup = false) {
  const run = startCli({
    args: ["start", "-b", backendUrl, "-p", "0"],
    env: { HOME: builtHome(backendUrl), DMS_SESSION_SECRET: SESSION_SECRET },
    ownGroup,
  });
  await waitFor(
    () => (run.output().includes("Ctrl+C to stop") ? true : undefined),
    run.output,
  );
  return run;
}

/** A backend serving a one-module manifest, for `dev` to set up from. */
function serveManifest(): Promise<{ server: Server; url: string }> {
  const layer = mkdtempSync(join(scratch, "layer-"));
  writeFileSync(
    join(layer, "package.json"),
    JSON.stringify({ name: "signals-layer" }),
  );
  const manifest = {
    version: 1,
    archive: "/dms/frontend/modules",
    modules: [
      {
        name: "signals-layer",
        archiveName: "signals-layer",
        priority: 0,
        renderer: { name: "vue", version: "3" },
        path: layer,
      },
    ],
  };
  return new Promise((settle) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      settle({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/** A `pnpm` on PATH whose install never finishes and runs a process tree. */
function hangingPnpm(): string {
  const bin = mkdtempSync(join(scratch, "bin-"));
  const pnpm = join(bin, "pnpm");
  writeFileSync(
    pnpm,
    `#!/bin/sh\nexec "${process.execPath}" "${PROCESS_TREE}"\n`,
  );
  chmodSync(pnpm, 0o755);
  return `${bin}:${process.env.PATH}`;
}

// Process groups are a POSIX notion; on Windows runCommand kills the tree
// with taskkill instead, which these pid checks cannot observe the same way.
const describeSignals = process.platform === "win32" ? describe.skip : describe;

describeSignals("stopping the CLI stops the whole child process tree", () => {
  before(() => {
    assert.ok(existsSync(CLI), `${CLI} is missing: run pnpm build first`);
    scratch = mkdtempSync(join(tmpdir(), "dms-frontend-signals-"));
  });
  after(() => {
    for (const pid of seen.filter(isAlive)) process.kill(pid, "SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  });

  it("exits 130 on Ctrl+C in a terminal while the server runs", async () => {
    const run = await startServer("http://127.0.0.1:9", true);
    const pids = await run.tree;

    // What a terminal does on Ctrl+C: SIGINT to the foreground process group.
    process.kill(-run.pid, "SIGINT");

    assert.deepEqual(await run.exited, { code: 130, signal: null });
    assert.match(run.output(), /✔ Production server ready in \S+\n/);
    assert.match(run.output(), /Local: +http:\/\/127\.0\.0\.1:1\//);
    assert.match(
      run.output(),
      /■ Stopped the production server · ran \d+(ms|\.\ds)\n/,
    );
    await assertTreeGone(pids);
  });

  it("exits 130 when only the CLI receives SIGINT", async () => {
    const run = await startServer("http://127.0.0.1:9");
    const pids = await run.tree;

    // kill -INT <pid>, or a CI runner cancelling the step: the child never
    // sees the signal unless the CLI passes it on.
    process.kill(run.pid, "SIGINT");

    assert.deepEqual(await run.exited, { code: 130, signal: null });
    assert.match(run.output(), /■ Stopped the production server · ran /);
    await assertTreeGone(pids);
  });

  it("prints a due update notice once, under the ready block", async () => {
    const backendUrl = "http://127.0.0.1:9";
    const home = builtHome(backendUrl);
    writeFileSync(
      join(home, ".antelopejs/dms-frontend/update-check.json"),
      JSON.stringify({
        checkedAt: Date.now(),
        latestVersion: "999.0.0",
        succeeded: true,
      }),
    );
    const run = startCli({
      args: ["start", "-b", backendUrl, "-p", "0"],
      entry: ["--import", TERMINAL_STDERR, CLI],
      env: {
        HOME: home,
        DMS_SESSION_SECRET: SESSION_SECRET,
        NO_UPDATE_NOTIFIER: "",
        CI: "",
        NO_COLOR: "1",
      },
    });
    const notice = `ℹ ajs dms 999.0.0 is available (you have ${version}) → ajs update dms\n`;
    await waitFor(
      () => (run.output().includes(notice) ? true : undefined),
      run.output,
    );
    const pids = await run.tree;

    process.kill(run.pid, "SIGINT");

    assert.deepEqual(await run.exited, { code: 130, signal: null });
    assert.ok(
      run.output().includes(`Ctrl+C to stop\n\n${notice}\n`),
      run.output(),
    );
    assert.equal(run.output().split(notice).length, 2, "printed once");
    await assertTreeGone(pids);
  });

  it("exits 143 on SIGTERM and says which signal stopped it", async () => {
    const run = await startServer("http://127.0.0.1:9");
    const pids = await run.tree;

    process.kill(run.pid, "SIGTERM");

    assert.deepEqual(await run.exited, { code: 143, signal: null });
    assert.match(
      run.output(),
      /■ Stopped the production server \(SIGTERM\) · ran /,
    );
    await assertTreeGone(pids);
  });

  it("exits 130 on Ctrl+C during the dependency install", async () => {
    const backend = await serveManifest();
    try {
      const run = startCli({
        args: ["dev", "-b", backend.url, "-p", "0"],
        env: { PATH: hangingPnpm() },
        ownGroup: true,
      });
      const pids = await run.tree;

      process.kill(-run.pid, "SIGINT");

      assert.deepEqual(await run.exited, { code: 130, signal: null });
      assert.match(run.output(), /■ Stopped\n/);
      assert.doesNotMatch(run.output(), /Setup failed/);
      await assertTreeGone(pids);
    } finally {
      await new Promise((settle) => backend.server.close(settle));
    }
  });

  it("kills the tree when the CLI exits for any other reason", async () => {
    const run = startCli({
      args: [],
      entry: [
        "--import",
        import.meta.resolve("tsx"),
        join(FIXTURES, "run-command-cli.ts"),
      ],
    });
    const pids = await run.tree;

    assert.deepEqual(await run.exited, { code: 3, signal: null });
    await assertTreeGone(pids);
  });
});
