import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import { isPidAlive } from "./discovery";
import { showPath } from "./output";

/**
 * Where the lock files live: one directory per uid on POSIX, since another
 * user could not create a file in a directory this one created. The uid needs
 * no passwd entry, which a container user often lacks. Windows has a
 * temporary directory per user.
 */
const LOCK_DIRECTORY = join(
  tmpdir(),
  process.getuid === undefined
    ? "ajs-dms-verify-source"
    : `ajs-dms-verify-source-${process.getuid()}`,
);

/**
 * Tries to create the lock: once, again after removing the files dead runs
 * left, and once more when its holder let it go between the failed create
 * and the read of its pid.
 */
const LOCK_ATTEMPTS = 3;

function lockPath(target: string): string {
  const key = createHash("sha256").update(target).digest("hex").slice(0, 16);
  return join(LOCK_DIRECTORY, `${key}.pid`);
}

/** The pid in a lock file, or undefined when it is gone or holds no pid. */
function lockHolder(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Runs `action`: true when it failed with the error `code`, false when it succeeded. Any other failure is thrown. */
function failsWith(code: string, action: () => void): boolean {
  try {
    action();
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === code)
      return true;
    throw error;
  }
}

/**
 * Creates `path` holding this pid, false when it exists. It is linked from a
 * file already written, so no other run ever reads it empty.
 */
function createHeld(path: string): boolean {
  const own = `${path}.${process.pid}.new`;
  rmSync(own, { force: true });
  writeFileSync(own, String(process.pid), { flag: "wx" });
  try {
    return !failsWith("EEXIST", () => linkSync(own, path));
  } finally {
    rmSync(own, { force: true });
  }
}

function runningProblem(target: string, pid: number, path: string): CliError {
  return new CliError({
    title: `A verification of ${showPath(target)} is already running`,
    reason: `Process ${pid} holds ${path}.`,
    fixes: [
      `Wait for process ${pid} to end, or stop it with kill ${pid}`,
      `Remove ${path} if process ${pid} is not a verification`,
    ],
  });
}

/**
 * Removes the file that the dead run `dead` left at `path`: a lock, or the
 * takeover file of a run that died while it removed one. Of the runs that
 * found it, only the one that creates its takeover file removes it, and only
 * while it still holds `dead`, so no run removes the file of a live one. A
 * takeover file left by a dead run is removed the same way first. Each
 * repeat follows the removal of a file a killed run left, so the files on
 * disk bound them.
 *
 * @throws CliError naming the run that is taking the lock over
 */
function removeDeadFile(path: string, dead: number, target: string): void {
  const takeover = `${path}.${dead}.takeover`;
  if (createHeld(takeover)) {
    try {
      if (lockHolder(path) === dead) rmSync(path, { force: true });
    } finally {
      rmSync(takeover, { force: true });
    }
    return;
  }
  const taker = lockHolder(takeover);
  if (taker === undefined) return;
  if (isPidAlive(taker)) throw runningProblem(target, taker, takeover);
  removeDeadFile(takeover, taker, target);
  removeDeadFile(path, dead, target);
}

/**
 * Takes the lock of `target` for this process, so a second verification of
 * it stops instead of running beside the first. A lock whose process is gone
 * is removed and taken over.
 *
 * @param target Absolute real path of the layer, or of the project without `--layer`
 * @returns Releases the lock
 * @throws CliError naming the pid of the live run that holds the lock
 */
export function lockVerification(target: string): () => void {
  mkdirSync(LOCK_DIRECTORY, { recursive: true });
  const path = lockPath(target);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
    if (createHeld(path))
      return () => {
        if (lockHolder(path) === process.pid) rmSync(path, { force: true });
      };
    const holder = lockHolder(path);
    if (holder === undefined) continue;
    if (isPidAlive(holder)) throw runningProblem(target, holder, path);
    removeDeadFile(path, holder, target);
  }
  throw new CliError({
    title: `Could not lock the verification of ${showPath(target)}`,
    reason: `${path} was still taken after ${LOCK_ATTEMPTS} attempts.`,
    fixes: [
      `Remove ${path} and its .takeover files if no verification is running`,
    ],
  });
}
