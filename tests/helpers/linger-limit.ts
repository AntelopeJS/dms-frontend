import { tracingChannel } from "node:diagnostics_channel";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a test file's process may stay alive with no test, suite or root hook running. */
const LINGER_LIMIT_MS = 10_000;

const SELF = fileURLToPath(import.meta.url);

const { setTimeout, clearTimeout } = globalThis;

let running = 0;
let lingerTimer: NodeJS.Timeout | undefined;

function failLingering(): void {
  process.stderr.write(
    `${process.argv[1]} still runs ${LINGER_LIMIT_MS} ms after its last test or hook finished, held by: ${process.getActiveResourcesInfo().join(", ")}\n`,
  );
  process.exit(1);
}

function armWhenIdle(): void {
  if (running === 0) {
    lingerTimer = setTimeout(failLingering, LINGER_LIMIT_MS).unref();
  }
}

function namesSelf(argument: string | undefined): boolean {
  return (
    argument !== undefined &&
    resolve(argument.replace(/^--import=/u, "")) === SELF
  );
}

/**
 * Preloaded with `--import` into each test file's process, it fails the file, naming it and what still
 * runs, when the process stays alive {@link LINGER_LIMIT_MS} with no `node.test` span open, a file that
 * registers no test included. A test's span covers its hooks, and the root's span covers the file's root
 * hooks. It drops itself from `process.execArgv`, so the processes a test forks, from any directory,
 * neither load it nor fail to resolve its relative path.
 */
process.execArgv = process.execArgv.filter(
  (argument, index, all) =>
    !namesSelf(argument) &&
    !(argument === "--import" && namesSelf(all[index + 1])),
);

tracingChannel("node.test").subscribe({
  start: () => {
    running += 1;
    clearTimeout(lingerTimer);
  },
  end: () => {
    running -= 1;
    armWhenIdle();
  },
  asyncStart: () => undefined,
  asyncEnd: () => undefined,
  error: () => undefined,
});
armWhenIdle();
