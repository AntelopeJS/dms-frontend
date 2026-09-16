import { join } from "node:path";
import chalk from "chalk";
import { Command } from "commander";
import {
  Options,
  projectWorkspaceKey,
  resolveBootstrapSecret,
  runCommand,
  setupWorkspace,
  startLayerWatchers,
} from "../common";
import { describeDiscoveryFailure, discoverBackend } from "../discovery";
import { type ReservedPort, reserveFreePort } from "../ports";
import { error, info, Spinner, warning } from "../utils/cli-ui";

interface DevOptions {
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
}

function resolveBackend(options: DevOptions): ResolvedBackend {
  if (options.backendUrl) {
    return { backendUrl: options.backendUrl };
  }

  const result = discoverBackend(process.cwd());
  if (result.status !== "found") {
    error(describeDiscoveryFailure(result));
    process.exit(1);
  }

  info(
    `Backend discovered from ${chalk.cyan(result.backend.projectDir)}: ${chalk.cyan(result.backend.backendUrl)}`,
  );
  return {
    backendUrl: result.backend.backendUrl,
    workspaceKey: projectWorkspaceKey(result.backend.projectDir),
  };
}

export function cmdDev(): Command {
  return new Command("dev")
    .description(
      "Start development server with hot reload (direct paths, same machine)",
    )
    .addOption(Options.backendUrl)
    .addOption(Options.port)
    .addOption(Options.force)
    .addOption(Options.offline)
    .addOption(Options.bootstrapSecret)
    .action(async (options: DevOptions) => {
      const { backendUrl, workspaceKey } = resolveBackend(options);
      const bootstrapSecret = resolveBootstrapSecret(
        options.bootstrapSecret,
        backendUrl,
      );

      // Resolve the frontend port BEFORE the manifest fetch: the real
      // port is sent to the backend as clientUrl so a dev backend can
      // serve a matching clientBaseUrl and whitelist the origin for CORS.
      // We reserve (not just probe) the port — the holding socket stays
      // bound through the whole workspace setup and is released right
      // before the frontend server binds, so nothing can steal it in between.
      const requestedPort = Number.parseInt(options.port, 10);
      if (Number.isNaN(requestedPort)) {
        error(`Invalid port: ${options.port}`);
        process.exit(1);
      }
      let reserved: ReservedPort;
      try {
        reserved = await reserveFreePort(requestedPort);
      } catch (err: any) {
        error(err.message);
        process.exit(1);
      }
      const port = reserved.port;
      if (port !== requestedPort) {
        warning(`Port ${requestedPort} in use, using ${port} instead`);
      }
      const clientUrl = `http://${clientHost()}:${port}`;

      const spinner = new Spinner("Setting up workspace...");
      await spinner.start();

      try {
        const { workspaceDir, layers, manifestFromCache, manifestFetchedAt } =
          await setupWorkspace({
            backendUrl,
            force: !!options.force,
            mode: "dev",
            offline: options.offline,
            clientUrl,
            workspaceKey,
            bootstrapSecret,
          });

        await spinner.succeed("Workspace ready");

        if (manifestFromCache) {
          warning(
            `Using cached layers manifest${manifestFetchedAt ? ` (cached on ${manifestFetchedAt})` : ""} — API calls will fail until the backend is up`,
          );
        }

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

        console.log("");
        info(`Starting dev server on port ${chalk.cyan(String(port))}...`);
        console.log(chalk.dim(`  Workspace: ${workspaceDir}`));
        console.log(chalk.dim(`  Backend:   ${backendUrl}`));
        console.log(
          chalk.dim(`  Watching:  ${layers.length} layer source tree(s)`),
        );
        console.log("");

        const nodeModulesDir = join(workspaceDir, "node_modules");
        // Hand the reserved port over to the frontend server at the last moment.
        await reserved.release();
        const code = await runCommand("node", ["server.mjs"], {
          cwd: workspaceDir,
          env: {
            ...process.env,
            PORT: String(port),
            DMS_DEV: "true",
            DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE ?? "false",
            DMS_API_BASE_URL: backendUrl,
            DMS_BOOTSTRAP_SECRET: bootstrapSecret,
            NODE_OPTIONS: "--max-old-space-size=4096",
            NODE_PATH: nodeModulesDir,
          },
        });

        await stopWatchers();
        process.exit(code);
      } catch (err: any) {
        await spinner.fail(`Setup failed: ${err.message}`);
        process.exit(1);
      }
    });
}
