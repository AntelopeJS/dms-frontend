/** A kind of one-way door. */
export type DoorKind = "data" | "format" | "contract" | "outbound" | "exposure" | "publish";

/** Path rules for one door kind: globs and declared funnel modules. */
export interface DoorRule {
  globs: string[];
  funnels: string[];
  why: string;
}

/**
 * How the gate decides whether a diff changed what the covered code does:
 * `emit` compares the JavaScript statements of the covered files on the
 * base and on HEAD (types, comments, formatting, imports and export
 * keywords left out); `probe` runs a command on a checkout of each, the
 * checkout's path as last argument, and compares what it prints.
 */
export type Behaviour = { kind: "emit" } | { kind: "probe"; command: string[] };

/**
 * A formal check: the source files it covers, the check's own files, the
 * command that runs it, how its output names a violated and a passing rule,
 * how the gate decides that a diff changed the covered behaviour, and the
 * command run on the base when it did or when the check's own files changed
 * (`command` when absent).
 */
export interface FormalCheck {
  name: string;
  covers: string[];
  files: string[];
  command: string[];
  baseCommand?: string[];
  violation: RegExp | null;
  passing: RegExp | null;
  behaviour: Behaviour;
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
  formal: FormalCheck[];
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
    format: {
      globs: ["src/workspace.ts", "src/materialize.ts", "src/derived-outputs.ts", "src/commands/build-action.ts", "src/commands/start-action.ts", "src/internal/built-workspace.ts", "src/internal/vite-manifest.ts", "src/asset-roots.ts"],
      funnels: [],
      why: "`ajs dms start` serves the workspace an earlier `build` wrote, so the next release must read what this one writes",
    },
    contract: {
      globs: ["src/index.ts", "src/commands/build.ts", "src/commands/clean.ts", "src/commands/dev.ts", "src/commands/prepare.ts", "src/commands/start.ts", "src/commands/verify-source.ts", "src/commands/workspaces.ts", "src/config.ts", "src/env-file.ts", "templates/vue/frontend-module.ts", "templates/vue/server-module.ts", "templates/vue/frontend-build.ts", "templates/vue/frontend-runtime/**", "templates/vue/server/module-routes.mjs", "templates/vue/server/module-server.mjs", "templates/vue/server/path-patterns.mjs", "src/renderer-range.ts"],
      funnels: [],
      why: "frontend modules import the SDK aliases, operators call the `ajs dms` commands and set the environment variables, and the DMS names the renderer range it runs on",
    },
    outbound: {
      globs: ["src/update-check.ts"],
      funnels: [],
      why: "the daily update check asks the npm registry about the package",
    },
    exposure: {
      globs: ["templates/vue/server/auth/**", "templates/vue/server/auth-hooks.mjs", "templates/vue/server/backend-proxies.mjs", "templates/vue/server/proxy-*.mjs", "templates/vue/server/public-endpoints.mjs", "templates/vue/server/request-routing.mjs", "templates/vue/server/static-files.mjs", "templates/vue/server/built-files.mjs", "templates/vue/server/dev-private-files.mjs", "templates/vue/server/route-rules.mjs", "templates/vue/server/icons.mjs", "templates/vue/server/email.mjs"],
      funnels: [],
      why: "the frontend server decides which paths reach the backend, with which session, and which files and routes answer a visitor",
    },
    publish: {
      globs: ["package.json", ".release-it.json", ".github/workflows/release.yml"],
      funnels: [],
      why: "the package name, its files and the release workflow claim @antelopejs/dms-frontend in the npm registry",
    },
  },
  formal: [
    {
      name: "formal-backend-exposure",
      covers: [
        "templates/vue/server.mjs",
        "templates/vue/icon-api.mjs",
        "templates/vue/server/auth/backend.mjs",
        "templates/vue/server/auth/client-ip.mjs",
        "templates/vue/server/auth/session.mjs",
        "templates/vue/server/backend-proxies.mjs",
        "templates/vue/server/backend-request.mjs",
        "templates/vue/server/icons.mjs",
        "templates/vue/server/module-routes.mjs",
        "templates/vue/server/module-server.mjs",
        "templates/vue/server/page-props.mjs",
        "templates/vue/server/path-patterns.mjs",
        "templates/vue/server/proxy-compression.mjs",
        "templates/vue/server/proxy-request.mjs",
        "templates/vue/server/proxy-transfers.mjs",
        "templates/vue/server/public-endpoints.mjs",
        "templates/vue/server/request-routing.mjs",
        "templates/vue/server/request-target.mjs",
      ],
      files: [".agents/skills/formal-backend-exposure/**"],
      command: ["node", ".agents/skills/formal-backend-exposure/check.mjs", "--full"],
      baseCommand: ["node", ".agents/skills/formal-backend-exposure/check.mjs"],
      violation: /^(?:finding|BROKEN|CHANGED|HOLDS) +(\w+)/gm,
      passing: /(?<=^holds +(?:\w+, )*)(\w+)(?=,| \()/gm,
      behaviour: { kind: "emit" },
    },
  ],
};

export default config;
