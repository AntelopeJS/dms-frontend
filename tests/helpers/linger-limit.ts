import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import nodeTest from "node:test";
import { fileURLToPath } from "node:url";

/** How long a test file's process may stay alive with no test or hook running. */
const LINGER_LIMIT_MS = 10_000;

const SELF = fileURLToPath(import.meta.url);

type Hook = typeof nodeTest.after;

let running = 0;
let lingerTimer: NodeJS.Timeout | undefined;

function failLingering(): void {
  process.stderr.write(
    `${process.argv[1]} still runs ${LINGER_LIMIT_MS} ms after its last test or hook finished, held by: ${process.getActiveResourcesInfo().join(", ")}\n`,
  );
  process.exit(1);
}

function enter(): void {
  running += 1;
  clearTimeout(lingerTimer);
}

function armWhenIdle(): void {
  if (running === 0) {
    lingerTimer = setTimeout(failLingering, LINGER_LIMIT_MS).unref();
  }
}

function leave(): void {
  running -= 1;
  armWhenIdle();
}

function tracked(register: Hook): Hook {
  return (fn, options) => {
    register(async (context) => {
      enter();
      try {
        await fn?.(context, () => undefined);
      } finally {
        leave();
      }
    }, options);
  };
}

function namesSelf(argument: string | undefined): boolean {
  return (
    argument !== undefined &&
    resolve(argument.replace(/^--import=/u, "")) === SELF
  );
}

/**
 * Preloaded with `--import` into each test file's process, it fails the file, naming it and what still
 * runs, when the process stays alive {@link LINGER_LIMIT_MS} with no test or `before`/`after` hook
 * running, a file that registers no test included. It drops itself from `process.execArgv`, so the
 * processes a test forks, from any directory, neither load it nor fail to resolve its relative path.
 */
process.execArgv = process.execArgv.filter(
  (argument, index, all) =>
    !namesSelf(argument) &&
    !(argument === "--import" && namesSelf(all[index + 1])),
);

nodeTest.before = tracked(nodeTest.before);
nodeTest.after = tracked(nodeTest.after);
syncBuiltinESMExports();
nodeTest.beforeEach(enter);
nodeTest.afterEach(leave);
armWhenIdle();
