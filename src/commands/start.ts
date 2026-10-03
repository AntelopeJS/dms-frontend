import { existsSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  getWorkspaceDir,
  collectManifestSecrets,
  Options,
  parseBackendUrl,
  parsePort,
  readCachedManifest,
  reportManifestSecrets,
  resolveManifestSecrets,
  resolveSessionSecret,
  runCommand,
} from "../common";
import { reservePort } from "../ports";
import { error, info } from "../utils/cli-ui";

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
      if (!options.backendUrl) {
        error("Backend URL is required. Use -b <url> or set DMS_API_BASE_URL.");
        process.exit(1);
      }

      const backendUrl = parseBackendUrl(options.backendUrl);
      const requestedPort = parsePort(options.port);
      const sessionSecret = resolveSessionSecret("start");

      const workspaceDir = getWorkspaceDir(backendUrl);
      const serverPath = join(workspaceDir, "server.mjs");
      const clientPath = join(workspaceDir, "dist", "client", "index.html");

      if (!existsSync(serverPath) || !existsSync(clientPath)) {
        console.error("");
        error("Production build not found!");
        console.error(
          chalk.dim(
            "  Run 'ajs dms build -b " +
              backendUrl +
              "' first to create a production build",
          ),
        );
        process.exit(1);
      }

      // Held until the server is spawned, as dev does, so a busy port is
      // reported here instead of as the server's unhandled listen error.
      const reserved = await reservePort(requestedPort);
      if (!reserved) {
        error(`Port ${requestedPort} is already in use`);
        console.error(
          chalk.dim(
            "  → Stop the process listening on it, or pass another port: -p <port>",
          ),
        );
        process.exit(1);
      }
      const port = reserved.port;

      console.error("");
      info(`Starting production server on port ${chalk.cyan(String(port))}...`);
      console.error(chalk.dim(`  Workspace: ${workspaceDir}`));

      // The build cached the manifest it was made from: the backend's
      // secrets come from there unless the environment sets its own.
      const secrets = resolveManifestSecrets(
        collectManifestSecrets(
          readCachedManifest(workspaceDir)?.manifest.modules ?? [],
        ),
      );
      reportManifestSecrets(secrets, "build-time manifest");
      console.error("");

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

      process.exit(code);
    });
}
