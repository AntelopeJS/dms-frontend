import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reapChildrenOnDeath } from "../../src/child-reaper";
import { runCommand } from "../../src/workspace-setup";

const child = join(dirname(fileURLToPath(import.meta.url)), "process-tree.mjs");
reapChildrenOnDeath();
void runCommand(process.execPath, [child], { stdio: "ignore" });
setInterval(() => {}, 1000);
