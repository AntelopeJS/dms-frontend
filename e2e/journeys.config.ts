import type { JourneysConfig } from "@antelopejs/dms/e2e";

export default {
  playground:
    process.env.DMS_PLAYGROUND ??
    `${process.env.HOME}/code/dms/packages/dms/playground`,
  renderer: ".",
  prepare: [
    [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--prefer-offline",
      "--ignore-scripts",
    ],
    ["pnpm", "run", "build"],
  ],
  smoke: "smoke",
} satisfies JourneysConfig;
