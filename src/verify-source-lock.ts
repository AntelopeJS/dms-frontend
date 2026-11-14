import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "@antelopejs/core/cli";
import { isPidAlive } from "./discovery";
import { showPath } from "./output";

/** Where the lock files live, shared by every user of the host's temporary directory. */
const LOCK_DIRECTORY = join(tmpdir(), "ajs-dms-verify-source");

/** Tries to create the lock: once, then once more after removing the lock of a dead run. */
const LOCK_ATTEMPTS = 2;

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

function runningProblem(target: string, pid: number, path: string): CliError {
  return new CliError({
    title: `A verification of ${showPath(target)} is already running`,
    reason: `Process ${pid} holds its lock, ${path}.`,
    fixes: [`Wait for process ${pid} to end, or stop it with kill ${pid}`],
  });
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
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return () => rmSync(path, { force: true });
    } catch (error) {
      if (
        !(error instanceof Error && "code" in error && error.code === "EEXIST")
      )
        throw error;
    }
    const holder = lockHolder(path);
    if (holder !== undefined && isPidAlive(holder))
      throw runningProblem(target, holder, path);
    rmSync(path, { force: true });
  }
  throw new CliError({
    title: `Could not lock the verification of ${showPath(target)}`,
    reason: `Another run took ${path} each of the ${LOCK_ATTEMPTS} times this one tried.`,
    fixes: ["Run it again once the other verification has started"],
  });
}
