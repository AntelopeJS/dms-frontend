import { resolve } from "node:path";
import { after } from "node:test";
import { fileURLToPath } from "node:url";

/** How long a test file's process may keep running after its tests finished. */
const LINGER_LIMIT_MS = 10_000;

const SELF = fileURLToPath(import.meta.url);

function namesSelf(argument: string | undefined): boolean {
  return (
    argument !== undefined &&
    resolve(argument.replace(/^--import=/u, "")) === SELF
  );
}

/**
 * Preloaded with `--import` into each test file's process, it fails the file, naming it and what still
 * runs, when a leaked handle keeps the process alive past {@link LINGER_LIMIT_MS} after its tests
 * finished. It drops itself from `process.execArgv`, so the processes a test forks, from any directory,
 * neither load it nor fail to resolve its relative path.
 */
process.execArgv = process.execArgv.filter(
  (argument, index, all) =>
    !namesSelf(argument) &&
    !(argument === "--import" && namesSelf(all[index + 1])),
);

after(() => {
  setTimeout(() => {
    process.stderr.write(
      `${process.argv[1]} still runs ${LINGER_LIMIT_MS} ms after its tests finished, held by: ${process.getActiveResourcesInfo().join(", ")}\n`,
    );
    process.exit(1);
  }, LINGER_LIMIT_MS).unref();
});
