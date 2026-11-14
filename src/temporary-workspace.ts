import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as nativePath from "node:path";
import { isPidAlive } from "./discovery";

type PathApi = typeof nativePath.win32;

/**
 * Where a workspace built from the sources in `projectDir` goes: the OS
 * temporary directory, unless that is on another drive, in which case
 * `.cache/dms-frontend` of the project. On Windows, a workspace on another
 * drive than the sources it builds loses their auto-imports, and so does a
 * workspace under `node_modules`, which the auto-importers skip.
 *
 * @internal
 */
export function temporaryWorkspaceParent(
  projectDir: string,
  temporary: string = tmpdir(),
  path: PathApi = nativePath,
): string {
  const project = path.resolve(projectDir);
  const sameDrive =
    path.parse(project).root.toLowerCase() ===
    path.parse(path.resolve(temporary)).root.toLowerCase();
  return sameDrive ? temporary : path.join(project, ".cache", "dms-frontend");
}

/** The pid that owns a workspace, after its prefix in the workspace's name. */
const OWNER_PID = /^(\d+)-/;

/**
 * Removes the workspaces named `prefix` in `parent` whose owner is dead: a run
 * killed with SIGKILL runs no exit handler. One a concurrent run is removing,
 * or that a dying run's tools still write to, is left to the next run.
 */
function removeDeadWorkspaces(parent: string, prefix: string): void {
  for (const name of readdirSync(parent)) {
    if (!name.startsWith(prefix)) continue;
    const owner = OWNER_PID.exec(name.slice(prefix.length));
    if (!owner || isPidAlive(Number(owner[1]))) continue;
    try {
      rmSync(nativePath.join(parent, name), { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Create a directory on the drive of `projectDir`, under the OS temporary
 * directory when it is on that drive, and remove it when the process exits.
 * Its name holds the pid of this process after `prefix`, so a later call
 * with the same prefix removes it if this process died without removing it.
 * Its path is the real one, with no Windows short (8.3) name in it, so the
 * paths the tools resolve inside it start with it.
 *
 * Cleanup hangs off "exit" rather than a try/finally so it also covers a
 * failed assertion, an uncaught exception, a rejected promise and an explicit
 * process.exit(). There is deliberately no signal handler: callers that run a
 * child through runCommand already handle the signal there, and a handler
 * here would keep any other caller alive instead of letting the default
 * action terminate it.
 */
export function createTemporaryWorkspace(
  prefix: string,
  projectDir: string,
): string {
  const parent = temporaryWorkspaceParent(projectDir);
  mkdirSync(parent, { recursive: true });
  removeDeadWorkspaces(parent, prefix);
  const workspace = realpathSync.native(
    mkdtempSync(nativePath.join(parent, `${prefix}${process.pid}-`)),
  );
  process.on("exit", () => {
    rmSync(workspace, { recursive: true, force: true });
  });
  return workspace;
}
