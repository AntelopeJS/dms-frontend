import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
  cachedAge,
  formatAge,
  showWorkspace,
  writeHeader,
  writeReadyBlock,
} from "../output";
import { reservePort } from "../ports";
import { readyLines, runServer } from "../server-process";
import { reportAvailableUpdate } from "../update-check";
import { compareWithBackend, reportFrontendReady } from "../module-set";
import { type BuildOrigin, manifestDigest, readBuildOrigin } from "../snapshot";
import { SERVER_OPTIONS_FILE } from "../config";
import { MANIFEST_SECRET_ENV } from "../manifest-secrets";
import {
  PRIVATE_OPTIONS_VARIABLE,
  parsePrivateOptions,
  unfilledPrivateValues,
} from "../private-values";
import type { FrontendModuleOptions } from "../workspace";

const BUILD_TIME_MANIFEST = "the build-time manifest";

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
  /** Workspace the build was made in, when it is not the one under the home. */
  workspace?: string;
}

/**
 * Says, once the server is ready, whether the backend still serves the
 * module set the build was made from, and how to refresh a snapshot that
 * aged. The server never waits for it.
 */
async function reportDrift(
  backendUrl: string,
  origin: BuildOrigin | undefined,
): Promise<void> {
  const ui = getProcessUi();
  const bootstrapSecret = process.env.DMS_BOOTSTRAP_SECRET?.trim();
  if (!origin) return;
  if (origin.authenticated === false) {
    ui.message(
      "info",
      `Built from modules ${origin.digest}; not compared with the backend`,
      {
        detail:
          "The build read the manifest without DMS_BOOTSTRAP_SECRET, which leaves out the backend proxies.",
      },
    );
    return;
  }
  if (!bootstrapSecret) {
    ui.message(
      "info",
      `Built from modules ${origin.digest}; not compared with the backend`,
      { detail: "Set DMS_BOOTSTRAP_SECRET to have start compare them." },
    );
    return;
  }
  const drift = await compareWithBackend(
    backendUrl,
    origin.digest,
    manifestDigest,
    bootstrapSecret,
  );
  if (drift.status === "matches") {
    ui.message(
      "info",
      `The backend serves the modules ${origin.digest} this build was made from`,
    );
    return;
  }
  if (drift.status === "unknown") {
    ui.message(
      "info",
      `Built from modules ${origin.digest}; not compared with the backend: ${drift.reason}`,
    );
    return;
  }
  const refresh =
    origin.source === "snapshot"
      ? `Refresh the snapshot and rebuild: ajs dms snapshot -b ${backendUrl} -o <dir>, then ajs dms build --from <dir>`
      : `Rebuild: ajs dms build -b ${backendUrl}`;
  ui.message(
    "warn",
    `The backend serves modules ${drift.served}; this build was made from ${origin.digest} (${origin.source}${cachedAge(origin.takenAt)})`,
    {
      details: [
        "Pages of modules added or removed since, or whose routes changed, are missing or stale.",
        `${ui.symbols.levels.hint} ${refresh}`,
      ],
    },
  );
}

export async function runStart(options: StartOptions): Promise<void> {
  const startedAt = Date.now();
  const explicitWorkspace = options.workspace
    ? resolve(options.workspace)
    : undefined;
  const origin = explicitWorkspace
    ? readBuildOrigin(explicitWorkspace)
    : undefined;
  const backendUrl = requireBackendUrl(
    options.backendUrl ?? origin?.backendUrl,
  );
  const requestedPort = parsePort(options.port);
  const sessionSecret = resolveSessionSecret("start");
  const workspaceDir = explicitWorkspace ?? getWorkspaceDir(backendUrl);
  const serverPath = join(workspaceDir, "server.mjs");
  const clientPath = join(workspaceDir, "dist", "client", "index.html");

  if (!existsSync(serverPath) || !existsSync(clientPath)) {
    throw new CliError({
      title: `No production build for ${backendUrl}`,
      reason: `${showWorkspace(workspaceDir)} has no built server or client.`,
      fixes: [
        explicitWorkspace
          ? `Build it first: ajs dms build --from <snapshot> --workspace ${options.workspace}`
          : `Build it first: ajs dms build -b ${backendUrl}`,
      ],
    });
  }

  // Serving from the workspace is a use, which `workspaces` reports. One the
  // caller named is not listed there, and may be read-only (an image): start
  // writes nothing into it.
  if (!explicitWorkspace) {
    writeWorkspaceMeta(
      workspaceDir,
      backendUrl,
      canonicalizeBackendUrl(backendUrl),
    );
  }
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

  // The build cached the manifest it was made from, without private values
  // since builds drop them: the server's secrets come from the environment.
  // A workspace built before keeps the ones it cached.
  const secrets = resolveManifestSecrets(
    collectManifestSecrets(
      readCachedManifest(workspaceDir)?.manifest.modules ?? [],
    ),
  );
  reportManifestSecrets(
    secrets,
    (count) =>
      `Set ${count === 1 ? "it" : "them"} in the server's environment, with the value${count === 1 ? "" : "s"} the backend uses`,
  );
  reportUnfilledPrivateValues(workspaceDir);
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
      void reportDrift(backendUrl, origin ?? readBuildOrigin(workspaceDir));
    },
  });

  process.exitCode = code;
}
