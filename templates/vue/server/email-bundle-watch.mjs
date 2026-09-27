// Development-only email bundle builder, forked by the frontend server.
//
// Runs Vite's email build in watch mode so `dist/server` exists as soon as the
// dev server does and follows every template edit the layer watchers mirror
// into the workspace. It lives in its own process so its builds never hold the
// dev server's event loop, and it reports each build over IPC so the server
// renders from a finished bundle only.

import { fileURLToPath } from "node:url";
import { build } from "vite";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The server owns this process: when its IPC channel closes, however the
// server ended, there is nobody left to build for.
process.on("disconnect", () => process.exit(0));

const watcher = await build({
  root: PROJECT_ROOT,
  configFile: fileURLToPath(
    new URL("../vite.email.config.ts", import.meta.url),
  ),
  logLevel: "warn",
  build: { watch: {} },
});

watcher.on("event", (event) => {
  if (event.code === "START") process.send?.({ state: "building" });
  else if (event.code === "END") process.send?.({ state: "ready" });
  else if (event.code === "ERROR") process.send?.({ state: "failed" });
});
