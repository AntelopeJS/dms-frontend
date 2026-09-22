import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a directory under the OS temporary directory and remove it when the
 * process exits, unless `keep` asks to leave it for inspection.
 *
 * Cleanup hangs off "exit" rather than a try/finally so it also covers a
 * failed assertion, an uncaught exception, a rejected promise and an explicit
 * process.exit(). There is deliberately no signal handler: callers block in
 * execFileSync, where Node defers JavaScript signal handlers until the child
 * returns, so a handler would keep the process alive through the whole install
 * or build instead of letting the default action terminate it.
 */
export function createTemporaryWorkspace(
  prefix: string,
  keep: boolean,
): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  if (!keep)
    process.on("exit", () => {
      rmSync(workspace, { recursive: true, force: true });
    });
  return workspace;
}
