// Writes the files Vite generates and the type check reads (auto-imports.d.ts
// and the Nuxt UI templates) without building anything: it resolves
// vite.config.ts and runs its build hooks over an empty entry, in seconds
// where a client build takes a minute. `ajs dms verify-source` runs it first
// (`pnpm run build:types`), so the type check no longer waits for the client
// bundle.

import { build } from "vite";

const ENTRY = "dms-prepare-types-entry";
const RESOLVED_ENTRY = `\0${ENTRY}`;

await build({
  configFile: "vite.config.ts",
  plugins: [
    {
      name: "dms-prepare-types-entry",
      enforce: "pre",
      resolveId: (id) => (id === ENTRY ? RESOLVED_ENTRY : null),
      load: (id) => (id === RESOLVED_ENTRY ? "export {};" : null),
    },
  ],
  build: {
    write: false,
    emptyOutDir: false,
    rollupOptions: {
      input: ENTRY,
      // The entry is empty on purpose.
      onwarn: (warning, warn) => {
        if (warning.code !== "EMPTY_BUNDLE") warn(warning);
      },
    },
  },
});
