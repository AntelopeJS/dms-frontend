import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { temporaryDirectory } from "../fixtures/temporary-directory.mts";
import { boundAddress } from "../helpers/net";
export const repository = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const builtEntry = join(repository, "dist/index.js");
/**
 * The CLI the runs spawn. CI builds before testing and sets DMS_PREBUILT, so
 * the runs take the compiled CLI, which starts several times faster than the
 * sources under tsx. Elsewhere `dist/` may be stale: the runs take the
 * sources.
 */
export const cliCommand =
  process.env.DMS_PREBUILT && existsSync(builtEntry)
    ? [builtEntry]
    : [
        "--import",
        import.meta.resolve("tsx"),
        join(repository, "src/index.ts"),
      ];

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The sandbox, both cwd and HOME of the run. */
  sandbox: string;
}

export interface RunCliOptions {
  /** Files written into the sandbox (cwd and HOME) before the CLI starts. */
  files?: Record<string, string>;
  /** Variables layered onto the child environment; undefined removes one. */
  env?: Record<string, string | undefined>;
  /** Whether stderr reads as a terminal, as in an interactive run. */
  isTerminal?: boolean;
}

export const TERMINAL_STDERR = import.meta.resolve("./terminal-stderr.mjs");

/**
 * Run the CLI the way a user outside any DMS project would: an empty cwd and
 * an empty home (HOME, and USERPROFILE, which Windows reads it from), so
 * `clean --all` can never reach the real workspaces.
 */
export async function runCli(
  args: string[],
  options: RunCliOptions = {},
): Promise<CliResult> {
  const sandbox = temporaryDirectory("dms-cli-");
  for (const [name, content] of Object.entries(options.files ?? {})) {
    mkdirSync(dirname(join(sandbox, name)), { recursive: true });
    writeFileSync(join(sandbox, name), content);
  }
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: sandbox,
    USERPROFILE: sandbox,
    NO_UPDATE_NOTIFIER: "1",
    DMS_API_BASE_URL: "",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_ALL: undefined,
    LC_CTYPE: undefined,
    NO_COLOR: undefined,
    FORCE_COLOR: undefined,
    ANTELOPEJS_VERBOSE: undefined,
    ANTELOPEJS_QUIET: undefined,
    ...options.env,
  };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) delete env[name];
  }
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      [
        ...(options.isTerminal ? ["--import", TERMINAL_STDERR] : []),
        ...cliCommand,
        ...args,
      ],
      { cwd: sandbox, env: env as NodeJS.ProcessEnv },
    );
    return { code: 0, stdout, stderr, sandbox };
  } catch (err: any) {
    return {
      code: err.code ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? "",
      sandbox,
    };
  }
}

export const BACKEND_URL = "http://127.0.0.1:5010";

/** Starts every ANSI color sequence. */
export const ESC = "\x1b";
export const SESSION_SECRET =
  "configured-session-secret-at-least-32-characters";

/** Sandbox-relative directory of the workspace build and start use. */
export function workspaceDir(backendUrl: string): string {
  const hash = createHash("sha256").update(backendUrl).digest("hex");
  return join(".antelopejs", "dms-frontend", hash);
}

/** Sandbox-relative directory a project's production build goes to. */
export const PRODUCTION_WORKSPACE = ".dms-frontend";

/**
 * A project without frontend modules, built: its server prints the port it
 * was given, then exits.
 */
export function builtWorkspace(): Record<string, string> {
  return {
    "antelope.config.ts": 'export default { name: "sandbox", modules: {} };\n',
    [join(PRODUCTION_WORKSPACE, "server.mjs")]:
      "console.log(`server port ${process.env.PORT}`);\n",
    [join(PRODUCTION_WORKSPACE, "dist", "client", "index.html")]:
      "<!doctype html>\n",
  };
}

export function listenOnFreePort(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0 }, () => {
      const address = boundAddress(server);
      if (address === undefined) {
        reject(new Error("No address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

export const COMMANDS = [
  "dev",
  "build",
  "start",
  "prepare",
  "workspaces",
  "clean",
  "verify-source",
];
export const HELP_WIDTH = 80;
