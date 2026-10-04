// Preloaded with --import: on exit, writes the path of every CommonJS module
// the process loaded to the file named by DMS_TEST_LOADED_MODULES.
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { cache } = createRequire(import.meta.url);
process.on("exit", () => {
  writeFileSync(
    process.env.DMS_TEST_LOADED_MODULES,
    JSON.stringify(Object.keys(cache)),
  );
});
