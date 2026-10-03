import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CliError, formatDuration } from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  getWorkspaceDir,
  collectManifestSecrets,
  describeSecretSources,
  Options,
  parsePort,
  readCachedManifest,
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

const BUILD_TIME_MANIFEST = "the build-time manifest";

interface StartOptions {
  backendUrl?: string;
  port: string;
}

export function cmdStart(): Command {
  return new Command("start")
    .description("Start the production server from a built workspace")
    .addOption(Options.backendUrl)
    .addOption(Options.port)
    .action(async (options: StartOptions) => {
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

      await reserved.release();
      const code = await runServer({
        name: "production server",
        script: serverPath,
        cwd: workspaceDir,
        env: {
          ...process.env,
          PORT: String(port),
          DMS_API_BASE_URL: backendUrl,
          DMS_SESSION_SECRET: sessionSecret,
          ...secrets.env,
          DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "true",
        },
        onReady: (address) =>
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
          }),
      });

      process.exitCode = code;
    });
}
