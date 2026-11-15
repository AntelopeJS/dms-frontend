import {
  type ChildProcess,
  type SpawnOptions,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  LineSplitter,
  OutputTail,
  type PathMapper,
  stripAnsi,
  writeChildLine,
} from "./child-output";
import { reapOnDeath } from "./child-reaper";
import { CancelledError, exitCodeForSignal } from "./cancellation";
import { isVerboseRun } from "@antelopejs/core/cli";

/** Signals the CLI forwards to the child instead of dying on its own. */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

/** How long a child may take to honor a forwarded signal before SIGKILL. */
const CHILD_SHUTDOWN_TIMEOUT_MS = 5000;

/**
 * Spawn a child process and wait for it to complete.
 *
 * The child owns a port (server.mjs, the Vite dev server) or writes to the
 * workspace (pnpm install, the production build), so neither it nor anything
 * it started may outlive the CLI. On POSIX the child leads its own process
 * group, so a terminal Ctrl-C reaches the CLI alone and the CLI stops the
 * whole tree at once: pnpm, the shell it runs a script in, and Vite under it.
 * On Windows the tree is killed with `taskkill /T`. The tree is killed
 * outright if the CLI goes down for any other reason.
 *
 * Resolves with the child's exit code; rejects with a `CancelledError` when
 * the CLI received SIGINT, SIGTERM or SIGHUP while the child was running.
 * `onSpawn` receives the child as soon as it exists, to read its piped output.
 *
 * A shell is spawned only on Windows, where npm-installed binaries are `.cmd`
 * shims. On POSIX dash would fork rather than exec, so the pid held here would
 * be the shell's and the signals would never reach the server.
 *
 * Windows gets no detached group, which would open a new console window.
 *
 * After the group signal, SIGKILL follows on POSIX: a grandchild that ignored
 * it would be reparented to init and outlive the CLI.
 */
export function runCommand(
  command: string,
  args: string[],
  options?: SpawnOptions,
  onSpawn?: (child: ChildProcess) => void,
): Promise<number> {
  const isWindows = process.platform === "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: isWindows,
      ...options,
      detached: !isWindows,
    });
    reapOnDeath(child);
    onSpawn?.(child);

    let escalation: NodeJS.Timeout | undefined;
    let forwarded: NodeJS.Signals | undefined;

    const alive = () => child.exitCode === null && child.signalCode === null;

    const signalTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        if (isWindows) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
          });
        } else {
          process.kill(-child.pid, signal);
        }
      } catch {}
    };

    const stopChild = (signal: NodeJS.Signals) => {
      if (!alive()) return;
      signalTree(signal);
      if (escalation || isWindows) return;
      escalation = setTimeout(() => {
        if (alive()) signalTree("SIGKILL");
      }, CHILD_SHUTDOWN_TIMEOUT_MS);
      escalation.unref();
    };

    const onSignal = (signal: NodeJS.Signals) => {
      forwarded = signal;
      stopChild(signal);
    };

    const onParentExit = () => {
      if (alive()) signalTree("SIGKILL");
    };

    for (const signal of FORWARDED_SIGNALS) process.on(signal, onSignal);
    process.on("exit", onParentExit);

    const cleanup = () => {
      if (escalation) clearTimeout(escalation);
      for (const signal of FORWARDED_SIGNALS) process.off(signal, onSignal);
      process.off("exit", onParentExit);
    };

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code, signal) => {
      cleanup();
      if (forwarded) {
        if (!isWindows) signalTree("SIGKILL");
        return reject(new CancelledError(forwarded));
      }
      if (code !== null) return resolve(code);
      resolve(exitCodeForSignal(signal ?? "SIGTERM"));
    });
  });
}

/** How long piped output may keep arriving once the child has exited. */
const OUTPUT_DRAIN_TIMEOUT_MS = 2000;

export interface FramedCommandOptions {
  /** Names the child in the gutter of a verbose run. */
  name: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Rewrites each line before anything reads it, e.g. workspace paths. */
  mapLine?: PathMapper;
  /** Receives each line, mapped and without colors. */
  onLine?: (line: string) => void;
}

export interface FramedCommandResult {
  code: number;
  /**
   * The last lines of stdout, then those of stderr, without colors. How the
   * child interleaved its two pipes is lost once both are read at once, so
   * each keeps its own order and errors stay at the end.
   */
  lines: string[];
}

/** Resolves once the stream ended or failed. */
function drained(stream: NodeJS.ReadableStream | null): Promise<void> {
  if (!stream) return Promise.resolve();
  return new Promise((settle) => {
    stream.once("end", settle);
    stream.once("error", settle);
  });
}

function drainTimeout(): Promise<void> {
  return new Promise((settle) => {
    setTimeout(settle, OUTPUT_DRAIN_TIMEOUT_MS).unref();
  });
}

/**
 * Runs pnpm in a generated workspace as `runFramedCommand` runs a child,
 * without the `COREPACK_ROOT` of a project that corepack runs. The workspace
 * pins the pnpm its patches and settings need, and pnpm 10 and later switch
 * themselves to that version unless they see `COREPACK_ROOT`: pnpm 11 and
 * later then refuse a pin they do not match, and pnpm 10 runs as itself.
 */
export function runWorkspacePnpm(
  args: string[],
  options: FramedCommandOptions,
): Promise<FramedCommandResult> {
  const { COREPACK_ROOT: _corepackRoot, ...env } = options.env ?? process.env;
  return runFramedCommand("pnpm", args, { ...options, env });
}

/**
 * Run a child whose output the CLI frames instead of letting it reach the
 * terminal: kept for the failure report, or streamed behind a gutter naming
 * the child in a verbose run. Signals stop it as `runCommand` does.
 */
export async function runFramedCommand(
  command: string,
  args: string[],
  options: FramedCommandOptions,
): Promise<FramedCommandResult> {
  const { name, cwd, env, mapLine = (line) => line, onLine } = options;
  const isVerbose = isVerboseRun();
  const tails = [new OutputTail(), new OutputTail()];
  const readLine = (tail: OutputTail, line: string) => {
    const mapped = mapLine(line);
    if (isVerbose) writeChildLine(name, mapped);
    const plain = stripAnsi(mapped);
    tail.push(plain);
    onLine?.(plain);
  };
  let ended: Promise<unknown> = Promise.resolve();
  const code = await runCommand(
    command,
    args,
    { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    (child) => {
      const streams = [child.stdout, child.stderr];
      for (const [index, stream] of streams.entries()) {
        const splitter = new LineSplitter((line) =>
          readLine(tails[index], line),
        );
        stream?.setEncoding("utf8");
        stream?.on("data", (chunk: string) => splitter.push(chunk));
        stream?.once("end", () => splitter.flush());
      }
      ended = Promise.all(streams.map((stream) => drained(stream)));
    },
  );
  await Promise.race([ended, drainTimeout()]);
  return { code, lines: tails.flatMap((tail) => tail.lines()) };
}
