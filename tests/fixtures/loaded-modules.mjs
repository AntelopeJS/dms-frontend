import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { cache } = createRequire(import.meta.url);
const target = process.env.DMS_TEST_LOADED_MODULES;
if (!target) throw new Error("DMS_TEST_LOADED_MODULES is not set");
process.on("exit", () => {
  writeFileSync(target, JSON.stringify(Object.keys(cache)));
});
