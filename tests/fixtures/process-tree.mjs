// Stand-in for a child that runs a tree of processes, like pnpm running
// `sh -c "vite build && ..."`: starts a grandchild that ignores SIGINT, then
// stays up forever. The grandchild publishes "<child pid> <grandchild pid>"
// to the file named by DMS_TEST_PID_FILE once its handler is in place.
// Started as the generated server, it reports itself ready as that one does.
import { spawn } from "node:child_process";

const grandchild = `
  process.on("SIGINT", () => {});
  require("node:fs").writeFileSync(
    process.env.DMS_TEST_PID_FILE,
    process.ppid + " " + process.pid,
  );
  setInterval(() => {}, 1000);
`;
spawn(process.execPath, ["-e", grandchild], { stdio: "ignore" });
process.send?.({ type: "dms:ready", address: "127.0.0.1", port: 1 });
setInterval(() => {}, 1000);
