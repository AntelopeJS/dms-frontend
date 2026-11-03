/** A kind of one-way door. */
export type DoorKind = "data" | "format" | "contract" | "outbound" | "exposure" | "publish";

/** Path rules for one door kind: globs, declared funnel modules, and the journeys, as `feature/journey`, that contain it. */
export interface DoorRule {
  globs: string[];
  funnels: string[];
  containments: string[];
  why: string;
}

/** The repo-owned layer of the verification skill, read by `dms-control`. */
export interface VerifyConfig {
  playground: string;
  renderer: string;
  prepare: string[][];
  userFacing: string[];
  notUserFacing: string[];
  smoke: string;
  smokeJourney: string;
  doors: Record<DoorKind, DoorRule | null>;
  formal: never[];
}

const config: VerifyConfig = {
  playground: process.env.DMS_PLAYGROUND ?? `${process.env.HOME}/code/dms/packages/dms/playground`,
  renderer: ".",
  prepare: [
    ["pnpm", "install", "--frozen-lockfile", "--prefer-offline", "--ignore-scripts"],
    ["pnpm", "run", "build"],
  ],
  userFacing: ["src/**", "templates/**", "skills/**", "package.json"],
  notUserFacing: ["templates/vue/patches/**", "templates/vue/gitignore", "templates/vue/npmrc", "skills/dms-frontend/cases.json"],
  smoke: "smoke",
  smokeJourney: "onboard, sign in through the rendered form, reload and stay signed in, sign out",
  doors: {
    data: null,
    format: null,
    contract: null,
    outbound: null,
    exposure: null,
    publish: null,
  },
  formal: [],
};

export default config;
