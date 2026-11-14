import { type ChildProcess, spawn } from "node:child_process";
import { Socket } from "node:net";
import type { Writable } from "node:stream";

/**
 * The reaper reads one line per child: `+<pid>` once it started, `-<pid>`
 * once it exited. When its standard input closes, which happens when the
 * process that started it ends, however it ends, it kills the tree of every
 * child still listed: the process group the child leads on POSIX, the
 * `taskkill /T` tree on Windows.
 */
const REAPER_SCRIPT = `
const children = new Set();
let rest = "";
const killTree = (pid) => {
  try {
    if (process.platform === "win32")
      require("node:child_process").spawnSync(
        "taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {}
};
const reap = () => {
  for (const pid of children) killTree(pid);
  children.clear();
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const lines = (rest + chunk).split("\\n");
  rest = lines.pop();
  for (const line of lines) {
    const pid = Number(line.slice(1));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (line.startsWith("+")) children.add(pid);
    else children.delete(pid);
  }
});
process.stdin.on("end", reap);
process.stdin.on("error", reap);
`;

let reaper: Writable | undefined;

/**
 * Starts the reaper of this process, once: from then on, every child
 * `runCommand` starts is killed with its tree when this process dies, SIGKILL
 * included, which no exit handler sees.
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
  const listed = reaper;
  listed.write(`+${pid}\n`);
  child.once("exit", () => listed.write(`-${pid}\n`));
}
