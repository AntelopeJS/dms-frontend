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
