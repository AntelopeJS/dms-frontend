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
    rolldownOptions: { input: ENTRY },
  },
});
