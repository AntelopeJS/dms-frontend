import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startSourceRunner } from "../../src/source-runner";
import { createTemporaryWorkspace } from "../../src/temporary-workspace";
import { runCommand } from "../../src/workspace-setup";

const child = join(dirname(fileURLToPath(import.meta.url)), "process-tree.mjs");
startSourceRunner(
  async () => {
    const workspace = createTemporaryWorkspace(
      "dms-frontend-runner-test-",
      process.cwd(),
    );
    writeFileSync(
      process.env.DMS_TEST_WORKSPACE_FILE ?? "",
      `${process.pid} ${workspace}`,
    );
    await runCommand(process.execPath, [child], {
      cwd: workspace,
      stdio: "ignore",
    });
    return { ok: true };
  },
  () => {},
);
