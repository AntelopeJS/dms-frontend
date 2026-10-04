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
import { setUpWorkspace } from "./workspace-task";

export interface DevOptions {
  backendUrl?: string;
  port: string;
  force?: boolean;
  offline?: boolean;
  bootstrapSecret?: string;
}

/**
 * Host advertised to the backend in `clientUrl`. The frontend server honors the HOST
 * env var when binding, so a non-default HOST means localhost is the
 * wrong origin. Wildcard binds (0.0.0.0, ::) are not reachable origins,
 * though — the browser will still use a concrete address, and localhost
 * is the best guess we have.
 */
function clientHost(): string {
  const host = process.env.HOST?.trim();
  if (!host || host === "0.0.0.0" || host === "::" || host === "[::]") {
    return "localhost";
  }
  // Bare IPv6 literals need brackets inside a URL.
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

export async function runDev(options: DevOptions): Promise<void> {
  const startedAt = Date.now();
  const requestedPort = parsePort(options.port);
  const offline = flagOrEnv(options.offline, "DMS_OFFLINE");
  const sessionSecret = resolveSessionSecret("dev");
  const { backendUrl, workspaceKey, projectDir } = resolveBackend(options);
  const bootstrapSecret = resolveBootstrapSecret(
    options.bootstrapSecret,
    backendUrl,
  );
  const ui = getProcessUi();

  writeHeader("dev", [backendUrl, "development"]);
  if (projectDir) {
    ui.message("info", `Backend discovered from ${showPath(projectDir)}`);
  }

  // Resolve the frontend port BEFORE the manifest fetch: the real
  // port is sent to the backend as clientUrl so a dev backend can
  // serve a matching clientBaseUrl and whitelist the origin for CORS.
  // We reserve (not just probe) the port — the holding socket stays
  // bound through the whole workspace setup and is released right
  // before the frontend server binds, so nothing can steal it in between.
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
  });

  // Reported once the setup succeeded: a failed setup makes the
  // fallback port irrelevant.
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
  const secrets = resolveManifestSecrets(manifestSecrets);
  reportManifestSecrets(
    secrets,
    (count) =>
      `Set ${count === 1 ? "it" : "them"} in the environment or the project's .env`,
  );

  // Start a chokidar watcher per layer that mirrors source edits
  // into the materialized workspace copy. Without this, HMR would
  // be blind to any change made in the real layer source tree,
  // since we copy (not symlink) layers into the workspace.
  const stopWatchers = startLayerWatchers(workspaceDir, layers);
  const handleShutdown = async () => {
    await stopWatchers();
  };
  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);

  const nodeModulesDir = join(workspaceDir, "node_modules");
  // Hand the reserved port over to the frontend server at the last moment.
  await reserved.release();
  const secretSources = describeSecretSources(secrets.sources);
  const code = await runServer({
    name: "dev server",
    script: "server.mjs",
    cwd: workspaceDir,
    mapPath: createPathMapper(workspaceDir, layers),
    env: {
      ...process.env,
      PORT: String(port),
      DMS_DEV: "true",
      DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "false",
      DMS_API_BASE_URL: backendUrl,
      DMS_BOOTSTRAP_SECRET: bootstrapSecret,
      DMS_SESSION_SECRET: sessionSecret,
      ...secrets.env,
      NODE_OPTIONS: "--max-old-space-size=4096",
      NODE_PATH: nodeModulesDir,
    },
    onReady: (address) => {
      writeReadyBlock({
        title: `Dev server ready in ${formatDuration(Date.now() - startedAt)}`,
        lines: readyLines(address, [
          { label: "Backend", value: backendUrl },
          { label: "Workspace", value: showWorkspace(workspaceDir) },
          ...(secretSources
            ? [{ label: "Secrets", value: secretSources }]
            : []),
        ]),
        footer: [
          `Watching ${pluralize(layers.length, "layer source")}`,
          "Ctrl+C to stop",
        ].join(ui.symbols.separator),
      });
      void reportAvailableUpdate({ isFollowed: true });
    },
  }).finally(stopWatchers);

  process.exitCode = code;
}
