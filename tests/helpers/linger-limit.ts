import { tracingChannel } from "node:diagnostics_channel";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** How long a test file's process may stay alive after its tests and root hooks finished. */
const LINGER_LIMIT_MS = 10_000;

const SELF = fileURLToPath(import.meta.url);

const { setTimeout, clearTimeout } = globalThis;

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 16)) {
  throw new Error(
    `tests/helpers/linger-limit.ts needs the node.test tracing channel of Node 24.16 or later, not ${process.version}`,
  );
}

interface TestSpan {
  readonly name: string;
  readonly nesting: number;
}

let lingerTimer: NodeJS.Timeout | undefined;

function failLingering(): void {
  process.stderr.write(
    `${process.argv[1]} still runs ${LINGER_LIMIT_MS} ms after its tests and root hooks finished, held by: ${process.getActiveResourcesInfo().join(", ")}\n`,
  );
  process.exit(1);
}

function arm(): void {
  clearTimeout(lingerTimer);
  lingerTimer = setTimeout(failLingering, LINGER_LIMIT_MS).unref();
}

function isRoot(span: TestSpan): boolean {
  return span.nesting === 0 && span.name === "<root>";
}

function namesSelf(argument: string | undefined): boolean {
  return (
    argument !== undefined &&
    resolve(argument.replace(/^--import=/u, "")) === SELF
  );
}

/**
 * Preloaded with `--import` into each test file's process, it fails the file, naming it and what still
 * runs, when the process stays alive {@link LINGER_LIMIT_MS} after the `<root>` span of `node.test` ends,
 * which Node publishes once every known test and root `after` hook finished, again after each batch of
 * tests registered after a top-level `await`. A test that starts clears the limit. The limit also runs
 * from load until the first test starts, so a file that registers no test fails, and so does a file
 * whose root `before`, `beforeEach` or top-level `await` holds its first test back past the limit. It
 * drops itself from `process.execArgv`, so the processes a test forks, from any directory,
 * neither load it nor fail to resolve its relative path.
 */
process.execArgv = process.execArgv.filter(
  (argument, index, all) =>
    !namesSelf(argument) &&
    !(argument === "--import" && namesSelf(all[index + 1])),
);

tracingChannel<string, TestSpan>("node.test").subscribe({
  start: () => {
    clearTimeout(lingerTimer);
  },
  end: (span) => {
    if (isRoot(span)) {
      arm();
    }
  },
  asyncStart: () => undefined,
  asyncEnd: () => undefined,
  error: () => undefined,
});
arm();
