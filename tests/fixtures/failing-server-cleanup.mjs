// Preloaded by server-ready-cleanup.test.mts: removing a development server's
// directory fails, as it does when Vite still writes its cache into it.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const remove = fs.rmSync;
fs.rmSync = (path, options) => {
  if (String(path).includes("dms-dev-host-"))
    throw Object.assign(
      new Error(`ENOTEMPTY, Directory not empty: ${String(path)}`),
      {
        code: "ENOTEMPTY",
      },
    );
  return remove(path, options);
};
syncBuiltinESMExports();
