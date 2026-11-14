import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import type { Writable } from "node:stream";

/**
 * The file a run writes in each directory it hands the reaper, holding a token
 * only that run and its reaper know.
 *
 * @internal
 */
export const OWNER_FILE = ".dms-frontend-owner";

/** One line the reaper reads: what the process that started it now owns. */
type ReaperEntry =
  | { started: number }
  | { exited: number }
  | { directory: string; token: string };

/**
 * The reaper reads one JSON line per {@link ReaperEntry}. When its standard
 * input closes, which happens when the process that started it ends, however
 * it ends, it kills the tree of every child still listed: the process group
 * the child leads on POSIX, the `taskkill /T` tree on Windows. Then it removes
 * each directory listed whose owner file still holds its token, and nothing
 * else.
 */
const REAPER_SCRIPT = `
const { readFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const children = new Set();
const directories = [];
let rest = "";
const killTree = (pid) => {
  try {
    if (process.platform === "win32")
      require("node:child_process").spawnSync(
        "taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {}
};
const isOwned = ({ directory, token }) => {
  try {
    return readFileSync(join(directory, ${JSON.stringify(OWNER_FILE)}), "utf8") === token;
  } catch {
    return false;
  }
};
const read = (line) => {
  try {
    const entry = JSON.parse(line);
    if (Number.isInteger(entry.started)) children.add(entry.started);
    else if (Number.isInteger(entry.exited)) children.delete(entry.exited);
    else if (typeof entry.directory === "string" && typeof entry.token === "string")
      directories.push(entry);
  } catch {}
};
const reap = () => {
  for (const pid of children) killTree(pid);
  children.clear();
  for (const owned of directories.splice(0))
    if (isOwned(owned))
      try {
        rmSync(owned.directory, { recursive: true, force: true, maxRetries: 10 });
      } catch {}
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (rest + chunk).split("\\n");
  rest = lines.pop();
  lines.forEach(read);
});
process.stdin.on("end", reap);
process.stdin.on("error", reap);
`;

let reaper: Writable | undefined;

function tell(entry: ReaperEntry): void {
  reaper?.write(`${JSON.stringify(entry)}\n`);
}

/**
 * Starts the reaper of this process, once: from then on, every child
 * `runCommand` starts is killed with its tree when this process dies, SIGKILL
 * included, which no exit handler sees, and every directory handed to
 * {@link removeOnDeath} is removed.
 */
export function reapChildrenOnDeath(): void {
  if (reaper) return;
  const isWindows = process.platform === "win32";
  const child = spawn(process.execPath, ["-e", REAPER_SCRIPT], {
    detached: !isWindows,
    stdio: ["pipe", "ignore", "ignore"],
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
  const { stdin } = child;
  stdin.on("error", () => {});
  if (stdin instanceof Socket) stdin.unref();
  reaper = stdin;
}

/** Lists `child` with the reaper of this process, if it has one, until it exits. */
export function reapOnDeath(child: ChildProcess): void {
  const { pid } = child;
  if (!reaper || pid === undefined) return;
  tell({ started: pid });
  child.once("exit", () => tell({ exited: pid }));
}

/**
 * Hands `directory`, which this process created, to its reaper, if it has
 * one: the reaper removes it once this process dies, provided the owner file
 * this writes in it still holds the same token.
 */
export function removeOnDeath(directory: string): void {
  if (!reaper) return;
  const token = randomUUID();
  writeFileSync(join(directory, OWNER_FILE), token);
  tell({ directory, token });
}
