import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/workspace-setup";

const runner = join(
  dirname(fileURLToPath(import.meta.url)),
  "source-runner.ts",
);
void runCommand(process.execPath, ["--import", "tsx", runner], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
