import { join } from "node:path";
import {
  CliError,
  formatDuration,
  getProcessUi,
  pluralize,
} from "@antelopejs/core/cli";
import {
  describeSecretSources,
  parseBackendUrl,
  parsePort,
  projectWorkspaceKey,
  flagOrEnv,
  resolveBootstrapSecret,
  reportManifestSecrets,
  resolveManifestSecrets,
  resolveSessionSecret,
  startLayerWatchers,
} from "../common";
import { createPathMapper } from "../child-output";
import { describeDiscoveryFailure, discoverBackend } from "../discovery";
import {
  cachedAge,
  showPath,
  showWorkspace,
  writeHeader,
  writeReadyBlock,
} from "../output";
import { reserveFreePort } from "../ports";
import { readyLines, runServer } from "../server-process";
import { reportAvailableUpdate } from "../update-check";
import { readCachedManifest } from "../manifest";
import {
  followModuleSet,
  type ModuleSetMember,
  moduleSetFingerprint,
  reportFrontendReady,
} from "../module-set";
import { readShippingVersion } from "../project-modules";
import { setUpWorkspace } from "./workspace-task";
import { serverNodeOptions } from "../node-options";

export interface DevOptions {
  backendUrl?: string;
  port: string;
  force?: boolean;
  offline?: boolean;
  bootstrapSecret?: string;
  /** The project the modules are read from; the discovered one by default. */
  project?: string;
  /** The AntelopeJS environment the backend runs, as `ajs project dev -e`. */
  env?: string;
}

/** The environment `ajs project dev` runs without `-e`. */
const BASE_ENVIRONMENT = "default";

/**
 * Host advertised to the backend in `clientUrl`. The frontend server honors the HOST
 * env var when binding, so a non-default HOST means localhost is the
 * wrong origin. Wildcard binds (0.0.0.0, ::) are not reachable origins,
 * though — the browser will still use a concrete address, and localhost
 * is the best guess we have.
 *
 * Bare IPv6 literals need brackets inside a URL.
 */
function clientHost(): string {
  const host = process.env.HOST?.trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "localhost";
  }
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * Resolve the backend to use: the explicit `-b`/`DMS_API_BASE_URL` value
 * when given, otherwise the enclosing antelope project's live dev
 * registry (`.antelope/dev.json`). Autodiscovery also switches the
 * workspace identity from the backend URL to the project path, so the
 * workspace (node_modules, manifest cache, appId scope) survives the
 * backend landing on a different port between runs.
 */
interface ResolvedBackend {
  backendUrl: string;
  workspaceKey?: string;
  /** The project the backend was discovered from, when it was. */
  projectDir?: string;
}

function resolveBackend(options: DevOptions): ResolvedBackend {
  if (options.backendUrl) {
    return { backendUrl: parseBackendUrl(options.backendUrl) };
  }

  const result = discoverBackend(process.cwd());
  if (result.status !== "found") {
    throw new CliError(describeDiscoveryFailure(result));
  }
  return {
    backendUrl: result.backend.backendUrl,
    workspaceKey: projectWorkspaceKey(result.backend.projectDir),
    projectDir: result.backend.projectDir,
  };
}

/**
 * The frontend port is resolved before the manifest fetch: the real port is
 * sent to the backend as `clientUrl` so a dev backend can serve a matching
 * `clientBaseUrl` and whitelist the origin for CORS. The port is reserved,
 * not just probed: the holding socket stays bound through the whole
 * workspace setup and is released right before the frontend server binds, so
 * nothing can steal it in between.
 *
 * The fallback port is reported once the setup succeeded: a failed setup
 * makes it irrelevant.
 *
 * A development backend issues a new credential each time it restarts, and
 * publishes it where discovery reads it.
 */
export async function runDev(options: DevOptions): Promise<void> {
  const startedAt = Date.now();
  const requestedPort = parsePort(options.port);
  const offline = flagOrEnv(options.offline, "DMS_OFFLINE");
  const sessionSecret = resolveSessionSecret("dev");
  const { backendUrl, workspaceKey, projectDir } = resolveBackend(options);
  const project = {
    projectDir: options.project ?? projectDir ?? process.cwd(),
    environment: options.env ?? BASE_ENVIRONMENT,
  };
  const bootstrapSecret = resolveBootstrapSecret(
    options.bootstrapSecret,
    backendUrl,
  );
  const ui = getProcessUi();

  writeHeader("dev", [backendUrl, "development"]);
  if (projectDir) {
    ui.message("info", `Backend discovered from ${showPath(projectDir)}`);
  }

  const reserved = await reserveFreePort(requestedPort);
  const port = reserved.port;
  const clientUrl = `http://${clientHost()}:${port}`;

  const {
    workspaceDir,
    layers,
    manifestFromCache,
    manifestFetchedAt,
    manifestSecrets,
  } = await setUpWorkspace({
    backendUrl,
    force: !!options.force,
    mode: "dev",
    offline,
    clientUrl,
    workspaceKey,
    bootstrapSecret,
    project,
  });

  if (port !== requestedPort) {
    ui.message("warn", `Port ${requestedPort} is busy, using ${port}`);
  }
  if (manifestFromCache) {
    const manifest = `the layers manifest${cachedAge(manifestFetchedAt)}`;
    if (offline) {
      ui.message("info", `Offline: using ${manifest}`);
    } else {
      ui.message("warn", `Backend unreachable: using ${manifest}`, {
        detail: "API calls fail until the backend is up.",
      });
    }
  }
  const session: DevSession = {
    backendUrl,
    clientUrl,
    port,
    workspaceKey,
    bootstrapSecret,
    refreshBootstrapSecret: () =>
      resolveBootstrapSecret(options.bootstrapSecret, backendUrl),
    sessionSecret,
    startedAt,
    isOffline: !!offline,
  };
  let setup: DevSetup = { workspaceDir, layers, manifestSecrets };
  await reserved.release();
  for (;;) {
    const run = await serveWorkspace(session, setup);
    if (!run.isRestart) {
      process.exitCode = run.code;
      return;
    }
    ui.message(
      "info",
      "Frontend modules changed on the backend: rebuilding the workspace",
    );
    session.startedAt = Date.now();
    session.bootstrapSecret = session.refreshBootstrapSecret();
    setup = await setUpWorkspace({
      backendUrl,
      force: false,
      mode: "dev",
      offline: false,
      clientUrl,
      workspaceKey,
      bootstrapSecret: session.bootstrapSecret,
      project,
    });
  }
}

/** What stays the same across the restarts of one `dev` run. */
interface DevSession {
  backendUrl: string;
  clientUrl: string;
  port: number;
  workspaceKey?: string;
  bootstrapSecret?: string;
  refreshBootstrapSecret: () => string | undefined;
  sessionSecret: string;
  startedAt: number;
  isOffline: boolean;
}

/** The workspace one server of the run serves. */
type DevSetup = Pick<
  Awaited<ReturnType<typeof setUpWorkspace>>,
  "workspaceDir" | "layers" | "manifestSecrets"
>;

interface ServedRun {
  code: number;
  /** The server stopped because the backend's module set changed. */
  isRestart: boolean;
}

/**
 * The backend's module set when the workspace was set up, as the manifest it
 * cached lists them: what `followModuleSet` compares the backend's manifest
 * with. The backend only signals a change; the rebuild reads the project.
 */
function backendModuleSet(setup: DevSetup): ModuleSetMember[] {
  return readCachedManifest(setup.workspaceDir)?.manifest.modules ?? [];
}

function reportServed(session: DevSession, setup: DevSetup): Promise<boolean> {
  return reportFrontendReady(
    session.backendUrl,
    setup.layers.map((layer) => ({
      name: layer.name ?? layer.path,
      version: readShippingVersion(layer.path),
    })),
    session.bootstrapSecret,
  );
}

/**
 * Runs the dev server on `setup` until it exits, or until the backend serves
 * another set of frontend modules (a module installed or removed from the
 * Modules page), which stops it for a rebuild.
 *
 * Offline, the backend is not there to follow.
 *
 * The layer watchers mirror source edits into the materialized workspace copy:
 * HMR would otherwise be blind to changes in the real layer source tree, since
 * layers are copied, not symlinked.
 */
async function serveWorkspace(
  session: DevSession,
  setup: DevSetup,
): Promise<ServedRun> {
  const restart = new AbortController();
  const stopFollowing = session.isOffline
    ? () => undefined
    : followModuleSet({
        backendUrl: session.backendUrl,
        clientUrl: session.clientUrl,
        bootstrapSecret: () => {
          session.bootstrapSecret = session.refreshBootstrapSecret();
          return session.bootstrapSecret;
        },
        fingerprint: moduleSetFingerprint(backendModuleSet(setup)),
        onChange: () => restart.abort(),
        onUnchanged: () => void reportServed(session, setup),
      });
  const stopWatchers = startLayerWatchers(setup.workspaceDir, setup.layers);
  const handleShutdown = async () => {
    stopFollowing();
    await stopWatchers();
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
  try {
    const code = await runDevServer(session, setup, restart.signal);
    return { code, isRestart: restart.signal.aborted };
  } finally {
    process.off("SIGINT", handleShutdown);
    process.off("SIGTERM", handleShutdown);
    stopFollowing();
    await stopWatchers();
  }
}

function runDevServer(
  session: DevSession,
  setup: DevSetup,
  stopSignal: AbortSignal,
): Promise<number> {
  const secrets = resolveManifestSecrets(setup.manifestSecrets);
  reportManifestSecrets(
    secrets,
    (count) =>
      `Set ${count === 1 ? "it" : "them"} in the environment or the project's .env`,
  );
  const secretSources = describeSecretSources(secrets.sources);
  const nodeModulesDir = join(setup.workspaceDir, "node_modules");
  return runServer({
    name: "dev server",
    script: "server.mjs",
    cwd: setup.workspaceDir,
    mapPath: createPathMapper(setup.workspaceDir, setup.layers),
    stopSignal,
    env: {
      ...process.env,
      PORT: String(session.port),
      DMS_DEV: "true",
      DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "false",
      DMS_API_BASE_URL: session.backendUrl,
      DMS_BOOTSTRAP_SECRET: session.bootstrapSecret,
      DMS_SESSION_SECRET: session.sessionSecret,
      ...secrets.env,
      NODE_OPTIONS: serverNodeOptions(process.env.NODE_OPTIONS),
      NODE_PATH: nodeModulesDir,
    },
    onReady: (address) => {
      writeReadyBlock({
        title: `Dev server ready in ${formatDuration(Date.now() - session.startedAt)}`,
        lines: readyLines(address, [
          { label: "Backend", value: session.backendUrl },
          { label: "Workspace", value: showWorkspace(setup.workspaceDir) },
          ...(secretSources
            ? [{ label: "Secrets", value: secretSources }]
            : []),
        ]),
        footer: [
          `Watching ${pluralize(setup.layers.length, "layer source")}`,
          "Ctrl+C to stop",
        ].join(getProcessUi().symbols.separator),
      });
      void reportServed(session, setup);
      void reportAvailableUpdate({ isFollowed: true });
    },
  });
}
