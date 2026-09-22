// Creates a temporary workspace, reports its path on stdout, then ends the
// way argv asks: "succeed", "throw", "reject" or "keep".
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTemporaryWorkspace } from "../../src/temporary-workspace";

const mode = process.argv[2];
const workspace = createTemporaryWorkspace(
  "dms-frontend-workspace-test-",
  mode === "keep",
);
writeFileSync(join(workspace, "marker.txt"), "content");
process.stdout.write(`${workspace}\n`);

if (mode === "throw") throw new Error("verification failed");
if (mode === "reject") void Promise.reject(new Error("async failure"));
