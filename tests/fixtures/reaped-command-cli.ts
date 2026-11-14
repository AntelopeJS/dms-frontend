import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { reapChildrenOnDeath } from "../../src/child-reaper";
import { createTemporaryWorkspace } from "../../src/temporary-workspace";
import { runCommand } from "../../src/workspace-setup";

const child = join(dirname(fileURLToPath(import.meta.url)), "process-tree.mjs");
reapChildrenOnDeath();
const workspace = createTemporaryWorkspace(
  "dms-frontend-reaper-test-",
  process.cwd(),
);
writeFileSync(process.env.DMS_TEST_WORKSPACE_FILE ?? "", workspace);
void runCommand(process.execPath, [child], { cwd: workspace, stdio: "ignore" });
setInterval(() => {}, 1000);
