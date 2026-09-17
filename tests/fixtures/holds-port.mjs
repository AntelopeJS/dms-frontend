// Stand-in for the generated server.mjs: publishes its pid and then stays up
// forever, exactly like a process holding the frontend port.
import { writeFileSync } from "node:fs";

writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
