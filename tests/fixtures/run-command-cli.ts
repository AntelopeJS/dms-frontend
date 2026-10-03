// A CLI that dies on its own while the child it spawned through runCommand is
// still running, the way an uncaught exception would end `ajs dms dev`.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/workspace-setup";

const child = join(dirname(fileURLToPath(import.meta.url)), "process-tree.mjs");
void runCommand(process.execPath, [child], { stdio: "ignore" });

const published = setInterval(() => {
  if (!existsSync(process.env.DMS_TEST_PID_FILE ?? "")) return;
  clearInterval(published);
  process.exit(3);
}, 50);
