import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

/**
 * Points the home directory at a fresh empty directory, so a temp directory
 * that lies under the developer's real home is shown in full and not from
 * `~`. Returns the function that gives the home back.
 */
export function isolateHome(): () => void {
  const home = mkdtempSync(join(tmpdir(), "dms-isolated-home-"));
  const saved = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  };
}

/** Runs the file's tests with {@link isolateHome} in force. */
export function useIsolatedHome(): void {
  let restore: (() => void) | undefined;
  before(() => {
    restore = isolateHome();
  });
  after(() => restore?.());
}
