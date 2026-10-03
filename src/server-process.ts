// Running the generated server for `dev` and `start`. The server reports over
// IPC once it answers, or why it could not listen; the CLI words both, and
// the line a stopped run ends on.

import { networkInterfaces } from "node:os";
import {
  CliError,
  type CliProblem,
  formatDuration,
} from "@antelopejs/core/cli";
import type { ReadyLine } from "./output";
import { CancelledError, runCommand } from "./workspace-setup";

const READY_MESSAGE = "dms:ready";
const LISTEN_ERROR_MESSAGE = "dms:listen-error";
const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "::"]);
const LOCAL_HOST = "localhost";

/** Where the server listens, as it reported it. */
export interface ServerAddress {
  address: string;
  port: number;
}

interface ListenError {
  code?: string;
  message: string;
  host: string;
  port: number;
}

export interface RunServerOptions {
  /** `dev server`, `production server`: names the server in the stop line. */
  name: string;
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Called once the server answers. */
  onReady: (address: ServerAddress) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readReady(message: unknown): ServerAddress | undefined {
  if (!isRecord(message) || message.type !== READY_MESSAGE) return undefined;
  const { address, port } = message;
  if (typeof address !== "string" || typeof port !== "number") return undefined;
  return { address, port };
}

function readListenError(message: unknown): ListenError | undefined {
  if (!isRecord(message) || message.type !== LISTEN_ERROR_MESSAGE)
    return undefined;
  return {
    code: typeof message.code === "string" ? message.code : undefined,
    message: String(message.message),
    host: String(message.host),
    port: Number(message.port),
  };
}

/** What the CLI says when the server could not listen. */
export function describeListenError(error: ListenError): CliProblem {
  const { code, host, port } = error;
  if (code === "EADDRINUSE") {
    return {
      title: `Port ${port} is already in use`,
      reason: `Another process is listening on ${host}:${port}.`,
      fixes: ["Stop it, or pass another port: -p <port>"],
    };
  }
  if (code === "EADDRNOTAVAIL") {
    return {
      title: `The server cannot listen on ${host}:${port}`,
      reason: `${host} is not an address of this machine.`,
      fixes: ["Set HOST to one of its addresses, or unset it"],
    };
  }
  if (code === "EACCES") {
    return {
      title: `The server cannot listen on ${host}:${port}`,
      reason: "Permission denied: ports below 1024 need elevated privileges.",
      fixes: ["Pass a port above 1023: -p <port>"],
    };
  }
  return {
    title: `The server cannot listen on ${host}:${port}`,
    reason: error.message,
  };
}

function urlHost(address: string): string {
  if (WILDCARD_ADDRESSES.has(address)) return LOCAL_HOST;
  return address.includes(":") ? `[${address}]` : address;
}

/** The URL to open on this machine. */
function localUrl({ address, port }: ServerAddress): string {
  return `http://${urlHost(address)}:${port}/`;
}

/**
 * The URLs other machines reach the server at: one per external IPv4 address
 * when it listens on every interface, none when it listens on one address.
 */
function networkUrls(
  { address, port }: ServerAddress,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  if (!WILDCARD_ADDRESSES.has(address)) return [];
  return Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}/`);
}

/** The ready block's lines: the URLs the server answers at, then `settings`. */
export function readyLines(
  address: ServerAddress,
  settings: ReadyLine[],
  interfaces?: ReturnType<typeof networkInterfaces>,
): ReadyLine[] {
  return [
    { label: "Local", value: localUrl(address), isLink: true },
    ...networkUrls(address, interfaces).map((value) => ({
      label: "Network",
      value,
      isLink: true,
    })),
    ...settings,
  ];
}

/**
 * Run the server until it exits, with its output on the terminal. Resolves
 * with its exit code; throws a `CliError` when it could not listen, and a
 * `CancelledError` naming the server and how long it ran when a signal
 * stopped it.
 */
export async function runServer(options: RunServerOptions): Promise<number> {
  const { name, script, cwd, env, onReady } = options;
  let readyAt: number | undefined;
  let listenError: ListenError | undefined;
  try {
    const code = await runCommand(
      process.execPath,
      [script],
      {
        cwd,
        env,
        // The IPC channel needs the server to be node itself, not a shell.
        shell: false,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      },
      (child) => {
        child.on("message", (message) => {
          const ready = readReady(message);
          if (ready && readyAt === undefined) {
            readyAt = Date.now();
            onReady(ready);
          }
          listenError ??= readListenError(message);
        });
      },
    );
    if (listenError) throw new CliError(describeListenError(listenError));
    return code;
  } catch (error) {
    if (!(error instanceof CancelledError)) throw error;
    const ran =
      readyAt === undefined
        ? undefined
        : `ran ${formatDuration(Date.now() - readyAt)}`;
    throw new CancelledError(error.signal, `Stopped the ${name}`, ran);
  }
}
