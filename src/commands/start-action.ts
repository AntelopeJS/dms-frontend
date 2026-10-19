import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError, formatDuration, getProcessUi } from "@antelopejs/core/cli";
import {
  canonicalizeBackendUrl,
  getWorkspaceDir,
  collectManifestSecrets,
  describeSecretSources,
  parsePort,
  readCachedManifest,
  reportManifestSecrets,
  requireBackendUrl,
  resolveManifestSecrets,
  resolveSessionSecret,
  writeWorkspaceMeta,
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
import { reportFrontendReady } from "../module-set";

const BUILD_TIME_MANIFEST = "the build-time manifest";
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
}

export async function runStart(options: StartOptions): Promise<void> {
  const startedAt = Date.now();
  const backendUrl = requireBackendUrl(options.backendUrl);
  const requestedPort = parsePort(options.port);
  const sessionSecret = resolveSessionSecret("start");
  const workspaceDir = getWorkspaceDir(backendUrl);
  const serverPath = join(workspaceDir, "server.mjs");
  const clientPath = join(workspaceDir, "dist", "client", "index.html");

  if (!existsSync(serverPath) || !existsSync(clientPath)) {
    throw new CliError({
      title: `No production build for ${backendUrl}`,
      reason: `${showWorkspace(workspaceDir)} has no built server or client.`,
      fixes: [`Build it first: ajs dms build -b ${backendUrl}`],
    });
  }

  // Serving from the workspace is a use, which `workspaces` reports.
  writeWorkspaceMeta(
    workspaceDir,
    backendUrl,
    canonicalizeBackendUrl(backendUrl),
  );
  const builtAt = statSync(clientPath).mtime.toISOString();
  writeHeader("start", [
    backendUrl,
    "production",
    `built ${formatAge(builtAt)}`,
  ]);

  // Held until the server is spawned, as dev does, so a busy port is
  // reported here instead of as the server's unhandled listen error.
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

  // The build cached the manifest it was made from: the backend's
  // secrets come from there unless the environment sets its own.
  const secrets = resolveManifestSecrets(
    collectManifestSecrets(
      readCachedManifest(workspaceDir)?.manifest.modules ?? [],
    ),
  );
  reportManifestSecrets(
    secrets,
    (count) =>
      `Set ${count === 1 ? "it" : "them"}, or rebuild with DMS_BOOTSTRAP_SECRET so the manifest carries ${count === 1 ? "it" : "them"}`,
  );
  const secretSources = describeSecretSources(
    secrets.sources,
    BUILD_TIME_MANIFEST,
  );
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
      // The backend's module store reads it to tell the Modules page which
      // modules this build serves.
      void reportFrontendReady(
        backendUrl,
        (readCachedManifest(workspaceDir)?.manifest.modules ?? []).map(
          (module) => module.name,
        ),
        process.env.DMS_BOOTSTRAP_SECRET,
      );
      void reportAvailableUpdate({ isFollowed: true });
    },
  });

  process.exitCode = code;
}
