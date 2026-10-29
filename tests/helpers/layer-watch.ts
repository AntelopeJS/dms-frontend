import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { memoryUi } from "../fixtures/memory-ui";

export const memory = memoryUi();
let written = "";

/** What the watchers print while dev runs. */
export const output = {
  ui: memory.ui,
  write: (text: string) => {
    written += `${text}\n`;
  },
  stderr: () => written,
  clear: () => {
    written = "";
  },
};

/** Each notice the watchers printed, with its detail lines. */
export function warnings(): string[] {
  return output.stderr().split(/\n(?=\S)/);
}

const RETRY_WRITE_MS = 1_000;
const TIMEOUT_MS = 15_000;

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * Wait until `done` holds, repeating `act` meanwhile: a change made before the
 * watcher has finished its initial scan is not reported, so the first write
 * alone could be lost.
 */
export async function eventually(
  act: () => void,
  done: () => boolean,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastAct = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastAct >= RETRY_WRITE_MS) {
      act();
      lastAct = Date.now();
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (done()) return;
  }
  assert.fail("the watcher did not apply the change in time");
}
