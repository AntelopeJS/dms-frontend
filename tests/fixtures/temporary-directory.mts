// A directory under the OS temporary directory that the test file removes
// once all of its tests have run, for tests that leave files behind for an
// assertion to read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const created: string[] = [];

// One hook on the root of the file rather than one per test: the helpers that
// create these directories (a CLI run, a cache file) have no test context, and
// the test that asked for one still reads it after the helper returns. The
// hook runs whatever the outcome of the tests.
after(() => {
  for (const directory of created.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

export function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  created.push(directory);
  return directory;
}
