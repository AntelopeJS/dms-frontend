import { fileURLToPath } from "node:url";
import { versionOf } from "./cli-json.mjs";

const [MAJOR, MINOR] = (versionOf(fileURLToPath(new URL("../package.json", import.meta.url))) ?? "").split(".").map(Number);

/** The `engines` range of a frontend module that runs on the renderer of this checkout: its minor line. */
export const RENDERER_RANGE = `>=${MAJOR}.${MINOR}.0 <${MAJOR}.${MINOR + 1}.0`;
