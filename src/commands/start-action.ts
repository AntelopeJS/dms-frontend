import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CliError, formatDuration, getProcessUi } from "@antelopejs/core/cli";
import {
  describeSecretSources,
  getLayerSafeName,
  parsePort,
  reportManifestSecrets,
  requireBackendUrl,
  resolveManifestSecrets,
  resolveSessionSecret,
} from "../common";
import {
  formatAge,
  showWorkspace,
  writeHeader,
  writeReadyBlock,
} from "../output";
import { reservePort } from "../ports";
import { readyLines, runServer } from "../server-process";
import { reportAvailableUpdate } from "../update-check";
import {
  OWN_RELEASE,
  reportFrontendReadyOnceAnswered,
  type ServedModule,
} from "../module-set";
import {
  type ProjectFrontendModule,
  readProjectFrontendModules,
} from "../project-modules";
import { SERVER_OPTIONS_FILE } from "../config";
import { MANIFEST_SECRET_ENV } from "../manifest-secrets";
import {
  PRIVATE_OPTIONS_VARIABLE,
  parsePrivateOptions,
  unfilledPrivateValues,
} from "../private-values";
import type { FrontendModuleRegistryEntry } from "../derived-outputs";
import type { FrontendModuleOptions } from "../workspace";
import { productionWorkspace } from "./build-action";

const PUBLIC_OPTIONS_VARIABLE = "DMS_PUBLIC_OPTIONS";

/** The private options by module id the build wrote, none when unreadable. */
function builtPrivateOptions(
  workspaceDir: string,
): Record<string, FrontendModuleOptions> {
  try {
    const { modules } = JSON.parse(
      readFileSync(join(workspaceDir, SERVER_OPTIONS_FILE), "utf8"),
    ) as { modules?: Record<string, FrontendModuleOptions> };
    return modules ?? {};
  } catch {
    return {};
  }
}

/**
 * Warns about each private value of a module the server would receive empty
 * and that no named variable covers: a module's own secrets, which only
 * `DMS_PRIVATE_OPTIONS` can carry. Names the module and the option, never a
 * value.
 */
function reportUnfilledPrivateValues(workspaceDir: string): void {
  const unfilled = unfilledPrivateValues(
    builtPrivateOptions(workspaceDir),
    parsePrivateOptions(process.env[PRIVATE_OPTIONS_VARIABLE]),
    Object.values(MANIFEST_SECRET_ENV),
  );
  const ui = getProcessUi();
  unfilled.forEach(({ module, path }, index) => {
    const isLast = index === unfilled.length - 1;
    ui.message(
      "warn",
      `${module}: private option ${path.join(".")} is not set`,
      {
        details: isLast
          ? [
              `${ui.symbols.levels.hint} Set ${unfilled.length === 1 ? "it" : "them"} in ${PRIVATE_OPTIONS_VARIABLE}, a JSON object of options by module id, with the values the backend uses`,
            ]
          : [],
      },
    );
  });
}
const PRODUCTION = "production";

/**
 * The NODE_ENV the production server runs under. The SSR bundle reads
 * `process.env.NODE_ENV` at run time (Vite inlines it in the client bundle
 * only), and so do the packages it loads from the workspace: Vue, its server
 * renderer and vue-i18n pick their production or development build from it.
 * Unset, the server would render with the development builds, slower and
 * printing their warnings. A value the environment sets wins, as with
 * `vite preview`, `nuxi preview` and `next start`, with a warning when it is
 * not production.
 */
function serverNodeEnv(): string {
  const nodeEnv = process.env.NODE_ENV || PRODUCTION;
  if (nodeEnv !== PRODUCTION) {
    const ui = getProcessUi();
    ui.message(
      "warn",
      `NODE_ENV is ${nodeEnv}: the server renders with the development builds of Vue and its libraries`,
      {
        details: [
          `${ui.symbols.levels.hint} Unset it for start, or set it to ${PRODUCTION}`,
        ],
      },
    );
  }
  return nodeEnv;
}

export interface StartOptions {
  backendUrl?: string;
  port: string;
  /** The AntelopeJS project the build was made from. */
  project: string;
  /** The AntelopeJS environment whose configuration applies. */
  env: string;
  /** Workspace the build was made in, `<project>/.dms-frontend` by default. */
  workspace?: string;
}

/**
 * The public options of each module by its id in the build's registry, as
 * the project's configuration gives them with the current variables.
 */
function publicOptionsById(
  modules: ProjectFrontendModule[],
): Record<string, FrontendModuleOptions> {
  return Object.fromEntries(
    modules.map(({ layer }) => {
      const options = layer.options ?? {};
      return [
        getLayerSafeName(layer),
        layer.configKey ? { [layer.configKey]: options } : options,
      ];
    }),
  );
}

/**
 * The modules the build serves, from the registry its server reads: the
 * report names these, whatever the current variables would build. None when
 * the registry is unreadable.
 */
function builtModules(workspaceDir: string): ServedModule[] {
  try {
    const { modules } = JSON.parse(
      readFileSync(
        join(workspaceDir, "generated-frontend-modules.json"),
        "utf8",
      ),
    ) as { modules?: FrontendModuleRegistryEntry[] };
    return (modules ?? []).map((module) => ({
      name: module.name ?? module.id,
      version: module.version,
    }));
  } catch {
    return [];
  }
}

/**
 * Warns when the current variables give the project other modules than the
 * build serves: the server keeps serving the build's, so only a rebuild
 * brings in a module a variable turned on, or drops one it turned off.
 */
function reportModuleSetDrift(
  built: ServedModule[],
  modules: ProjectFrontendModule[],
): void {
  const builtNames = new Set(built.map(({ name }) => name));
  const currentNames = new Set(
    modules.map(({ layer }) => layer.name ?? layer.path),
  );
  const added = [...currentNames].filter((name) => !builtNames.has(name));
  const removed = [...builtNames].filter((name) => !currentNames.has(name));
  if (added.length === 0 && removed.length === 0) return;
  const ui = getProcessUi();
  ui.message(
    "warn",
    "The project's modules differ from the ones the build serves: rebuild to apply them",
    {
      details: [
        ...(added.length > 0
          ? [`Not in the build: ${added.sort().join(", ")}`]
          : []),
        ...(removed.length > 0
          ? [`Built, no longer in the project: ${removed.sort().join(", ")}`]
          : []),
        `${ui.symbols.levels.hint} Build again with the deployment's variables: ajs dms build`,
      ],
    },
  );
}

/**
 * Tells the backend which module versions this build serves, once it first
 * answers: the backend compares them with the ones it runs, and its module
 * store reads which modules the build serves. It warns only on a difference,
 * so the outcome is said here: that is the one trace the check ran.
 */
async function reportServedModules(
  backendUrl: string,
  modules: ServedModule[],
): Promise<void> {
  const isTaken = await reportFrontendReadyOnceAnswered(
    backendUrl,
    modules,
    process.env.DMS_BOOTSTRAP_SECRET,
  );
  const ui = getProcessUi();
  if (isTaken) {
    ui.message(
      "info",
      `[DMS] Reported ${modules.length} modules to the backend (dms-frontend ${OWN_RELEASE.version})`,
    );
    return;
  }
  ui.message(
    "warn",
    "[DMS] The backend refused the ready report: it cannot check this build's module versions",
    {
      details: [
        `${ui.symbols.levels.hint} Set DMS_BOOTSTRAP_SECRET to the backend's frontend.bootstrapSecret`,
      ],
    },
  );
}

/**
 * The port is held until the server is spawned, as `dev` does, so a busy
 * port is reported here instead of as the server's unhandled listen error.
 *
 * The private values are secrets the server reads from its environment: the
 * project's configuration never holds them.
 */
export async function runStart(options: StartOptions): Promise<void> {
  const startedAt = Date.now();
  const workspaceDir = resolve(productionWorkspace(options));
  const backendUrl = requireBackendUrl(options.backendUrl);
  const requestedPort = parsePort(options.port);
  const sessionSecret = resolveSessionSecret("start");
  const serverPath = join(workspaceDir, "server.mjs");
  const clientPath = join(workspaceDir, "dist", "client", "index.html");

  if (!existsSync(serverPath) || !existsSync(clientPath)) {
    throw new CliError({
      title: "No production build to serve",
      reason: `${showWorkspace(workspaceDir)} has no built server or client.`,
      fixes: [
        options.workspace
          ? `Build it first: ajs dms build --workspace ${options.workspace}`
          : "Build it first: ajs dms build",
      ],
    });
  }

  const builtAt = statSync(clientPath).mtime.toISOString();
  writeHeader("start", [
    backendUrl,
    options.env,
    `built ${formatAge(builtAt)}`,
  ]);

  const reserved = await reservePort(requestedPort);
  if (!reserved) {
    throw new CliError({
      title: `Port ${requestedPort} is already in use`,
      fixes: [
        "Stop the process listening on it, or pass another port: -p <port>",
      ],
    });
  }
  const port = reserved.port;

  const modules = await readProjectFrontendModules({
    projectDir: options.project,
    environment: options.env,
  });
  const built = builtModules(workspaceDir);
  reportModuleSetDrift(built, modules);
  const secrets = resolveManifestSecrets({ published: {}, conflicts: [] });
  reportManifestSecrets(
    secrets,
    (count) =>
      `Set ${count === 1 ? "it" : "them"} in the server's environment, with the value${count === 1 ? "" : "s"} the backend uses`,
  );
  reportUnfilledPrivateValues(workspaceDir);
  const secretSources = describeSecretSources(secrets.sources);
  const nodeEnv = serverNodeEnv();

  await reserved.release();
  const code = await runServer({
    name: "production server",
    script: serverPath,
    cwd: workspaceDir,
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
      PORT: String(port),
      DMS_API_BASE_URL: backendUrl,
      DMS_SESSION_SECRET: sessionSecret,
      [PUBLIC_OPTIONS_VARIABLE]: JSON.stringify(publicOptionsById(modules)),
      ...secrets.env,
      DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "true",
    },
    onReady: (address) => {
      writeReadyBlock({
        title: `Production server ready in ${formatDuration(Date.now() - startedAt)}`,
        lines: readyLines(address, [
          { label: "Backend", value: backendUrl },
          { label: "Workspace", value: showWorkspace(workspaceDir) },
          ...(secretSources
            ? [{ label: "Secrets", value: secretSources }]
            : []),
        ]),
        footer: "Ctrl+C to stop",
      });
      void reportServedModules(backendUrl, built);
      void reportAvailableUpdate({ isFollowed: true });
    },
  });

  process.exitCode = code;
}
