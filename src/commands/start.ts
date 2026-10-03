import { existsSync } from "node:fs";
import { join } from "node:path";
import { CliError, getProcessUi } from "@antelopejs/core/cli";
import { Command } from "commander";
import {
  getWorkspaceDir,
  collectManifestSecrets,
  Options,
  parsePort,
  readCachedManifest,
  reportManifestSecrets,
  requireBackendUrl,
  resolveManifestSecrets,
  resolveSessionSecret,
  runCommand,
} from "../common";
import { showWorkspace, writeBlankLine, writeHeader } from "../output";
import { reservePort } from "../ports";

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
      const backendUrl = requireBackendUrl(options.backendUrl);
      const requestedPort = parsePort(options.port);
      const sessionSecret = resolveSessionSecret("start");
      const ui = getProcessUi();

      writeHeader("start", [backendUrl, "production"]);

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

      ui.message("info", `Starting the production server on port ${port}`, {
        detail: `Workspace  ${showWorkspace(workspaceDir)}`,
      });

      // The build cached the manifest it was made from: the backend's
      // secrets come from there unless the environment sets its own.
      const secrets = resolveManifestSecrets(
        collectManifestSecrets(
          readCachedManifest(workspaceDir)?.manifest.modules ?? [],
        ),
      );
      reportManifestSecrets(secrets, "build-time manifest");
      writeBlankLine();

      await reserved.release();
      const code = await runCommand("node", [serverPath], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          PORT: String(port),
          DMS_API_BASE_URL: backendUrl,
          DMS_SESSION_SECRET: sessionSecret,
          ...secrets.env,
          DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "true",
        },
      });

      process.exitCode = code;
    });
}
