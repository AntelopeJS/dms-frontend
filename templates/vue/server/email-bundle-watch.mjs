import { fileURLToPath } from "node:url";
import { build } from "vite";
import { isObjectLike } from "./type-guards.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));

process.on("disconnect", () => process.exit(0));

/** @type {(() => void) | undefined} */
let startBuild;
process.on("message", (message) => {
  if (!isObjectLike(message) || message.state !== "build") return;
  startBuild?.();
  startBuild = undefined;
});

/** Holds each build until the server lets it replace the bundle. */
const serverHandoff = {
  name: "dms-email-bundle-handoff",
  buildStart() {
    if (!process.send) return;
    /** @type {Promise<void>} */
    const held = new Promise((start) => {
      startBuild = start;
      process.send?.({ state: "building" });
    });
    return held;
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

if (!("on" in watcher))
  throw new TypeError("The email bundle build did not start a watcher");
watcher.on("event", (event) => {
  if (event.code === "END") process.send?.({ state: "ready" });
  else if (event.code === "ERROR") process.send?.({ state: "failed" });
});
