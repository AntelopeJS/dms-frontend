// Development-only email bundle builder, forked by the frontend server.
//
// Runs Vite's email build in watch mode so `dist/server` exists as soon as the
// dev server does and follows every template edit the layer watchers mirror
// into the workspace. It lives in its own process so its builds never hold the
// dev server's event loop, and it reports each build over IPC so the server
// renders from a finished bundle only. A build empties `dist/server` first, so
// it asks the server before it starts and waits for the go-ahead, which the
// server gives once no render reads the previous bundle any more.

import { fileURLToPath } from "node:url";
import { build } from "vite";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

// The server owns this process: when its IPC channel closes, however the
// server ended, there is nobody left to build for.
process.on("disconnect", () => process.exit(0));

let startBuild;
process.on("message", (message) => {
  if (message?.state !== "build") return;
  startBuild?.();
  startBuild = undefined;
});

/** Holds each build until the server lets it replace the bundle. */
const serverHandoff = {
  name: "dms-email-bundle-handoff",
  buildStart() {
    if (!process.send) return;
    return new Promise((start) => {
      startBuild = start;
      process.send({ state: "building" });
    });
  },
};

const watcher = await build({
  root: PROJECT_ROOT,
  configFile: fileURLToPath(
    new URL("../vite.email.config.ts", import.meta.url),
  ),
  logLevel: "warn",
  plugins: [serverHandoff],
  build: { watch: {} },
});

watcher.on("event", (event) => {
  if (event.code === "END") process.send?.({ state: "ready" });
  else if (event.code === "ERROR") process.send?.({ state: "failed" });
});
