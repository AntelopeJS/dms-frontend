// The CLI half of the child-lifetime test: spawns a long-lived child through
// runCommand, the way `ajs dms start` and `ajs dms dev` spawn server.mjs.
//
// argv: <pid file> <mode>, mode being "wait" (exit with the child's code) or
// "self-exit" (the CLI dies on its own while the child is still running).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../src/workspace-setup";

const [pidFile, mode] = process.argv.slice(2);
const child = join(dirname(fileURLToPath(import.meta.url)), "holds-port.mjs");
const finished = runCommand(process.execPath, [child, pidFile], {
  stdio: "ignore",
});

if (mode === "self-exit") setTimeout(() => process.exit(3), 1500);
else void finished.then((code) => process.exit(code));
