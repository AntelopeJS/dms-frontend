// Running the generated server for `dev` and `start`. The server reports over
// IPC once it answers, or why it could not listen; the CLI words both, and
// the line a stopped run ends on.

import { existsSync, readdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  CliError,
  type CliProblem,
  formatDuration,
  pluralize,
} from "@antelopejs/core/cli";
import type { PathMapper } from "./child-output";
import type { ReadyLine } from "./output";
import { CancelledError } from "./cancellation";
import { runCommand } from "./workspace-setup";

const READY_MESSAGE = "dms:ready";
const LISTEN_ERROR_MESSAGE = "dms:listen-error";
const START_ERROR_MESSAGE = "dms:start-error";
/** The only command whose server starts Vite. */
const DEV_COMMAND = "ajs dms dev";
/** What Node says when an import names a package the workspace lacks. */
const MODULE_NOT_FOUND_CODES = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"];
const WILDCARD_ADDRESSES = new Set(["0.0.0.0", "::"]);
const LOCAL_HOST = "localhost";
/** Interfaces of containers and virtual machines, by the names their tools give them. */
const VIRTUAL_INTERFACE_NAME =
  /^(docker\d|br-|veth|virbr|cni|flannel|cali|cilium|weave|vxlan|kube-|podman|lxcbr|lxdbr|vboxnet|vmnet)/;
const LINK_LOCAL_IPV4 = /^169\.254\./;
/** Network URLs a ready block lists; the rest are counted. */
const MAX_NETWORK_URLS = 3;
const LINUX_NET_DIR = "/sys/class/net";

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

/** Where an error Vite failed to start on points. */
interface StartErrorLocation {
  file: string;
  line?: number;
  column?: number;
  /** The source line, when the error came with it. */
  lineText?: string;
}

/** Vite could not start in the dev server, so the server exited. */
export interface StartError {
  message: string;
  /** Node's error code, when it had one. */
  code?: string;
  location?: StartErrorLocation;
}

export interface RunServerOptions {
  /** `dev server`, `production server`: names the server in the stop line. */
  name: string;
  script: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Shows a path into the workspace as the source file it was copied from. */
  mapPath?: PathMapper;
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

function readStartError(message: unknown): StartError | undefined {
  if (!isRecord(message) || message.type !== START_ERROR_MESSAGE)
    return undefined;
  const { location } = message;
  const isLocated = isRecord(location) && typeof location.file === "string";
  return {
    message: String(message.message),
    code: typeof message.code === "string" ? message.code : undefined,
    location: isLocated
      ? {
          file: String(location.file),
          line: typeof location.line === "number" ? location.line : undefined,
          column:
            typeof location.column === "number" ? location.column : undefined,
          lineText:
            typeof location.lineText === "string"
              ? location.lineText
              : undefined,
        }
      : undefined,
  };
}

/** The line an error points at, with a caret under its column. */
function codeFrame(location: StartErrorLocation): string[] {
  const { line, column, lineText } = location;
  if (line === undefined || lineText === undefined) return [];
  const gutter = String(line);
  const caret = `${" ".repeat(column ?? 0)}^`;
  return [`${gutter} | ${lineText}`, `${" ".repeat(gutter.length)} | ${caret}`];
}

/**
 * What the CLI says when Vite could not start in the dev server: the file it
 * points at, as the source the user edits, then the error.
 */
export function describeStartError(
  error: StartError,
  mapPath: PathMapper = (path) => path,
): CliProblem {
  const { code, location } = error;
  const message = mapPath(error.message);
  if (code && MODULE_NOT_FOUND_CODES.includes(code)) {
    return {
      title: "Vite could not start in the dev server",
      reason: message,
      fixes: [`Reinstall the workspace dependencies: ${DEV_COMMAND} --force`],
    };
  }
  if (!location) {
    return {
      title: "Vite could not start in the dev server",
      reason: message,
      fixes: [
        `Look for the cause in Vite's output above, then run ${DEV_COMMAND} again`,
      ],
    };
  }
  const position =
    location.line === undefined
      ? ""
      : `:${location.line}:${location.column ?? 0}`;
  return {
    title: `Vite could not start: error in ${mapPath(location.file)}${position}`,
    reason: message,
    fixes: [`Fix the file and run ${DEV_COMMAND} again`],
    details: codeFrame(location),
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
 * Whether a Linux interface is a bridge no physical device is attached to:
 * one a container or VM manager made for its guests, whatever its name
 * (`docker0`, `br-1cd78ad94b16`, `pelican0`). A bridge holding the machine's
 * own network card stays a LAN address.
 */
export function isGuestBridge(
  name: string,
  netDir: string = LINUX_NET_DIR,
): boolean {
  if (!existsSync(join(netDir, name, "bridge"))) return false;
  const ports = readdirSync(join(netDir, name, "brif"));
  return !ports.some((port) => existsSync(join(netDir, port, "device")));
}

/** Whether this machine made the interface for its own containers or VMs. */
function isLinuxGuestBridge(name: string): boolean {
  try {
    return process.platform === "linux" && isGuestBridge(name);
  } catch {
    return false;
  }
}

/**
 * The URLs other machines reach the server at, when it listens on every
 * interface: one per LAN IPv4 address, without loopback, link-local and
 * container or VM interfaces. None when it listens on one address.
 */
function networkUrls(
  { address, port }: ServerAddress,
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
  isGuestInterface: (name: string) => boolean = isLinuxGuestBridge,
): string[] {
  if (!WILDCARD_ADDRESSES.has(address)) return [];
  return Object.entries(interfaces)
    .filter(([name]) => !VIRTUAL_INTERFACE_NAME.test(name))
    .filter(([name]) => !isGuestInterface(name))
    .flatMap(([, entries]) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .filter((entry) => !LINK_LOCAL_IPV4.test(entry.address))
    .map((entry) => `http://${entry.address}:${port}/`);
}

/**
 * The ready block's lines: the URLs the server answers at, a few network
 * ones at most, then `settings`.
 */
export function readyLines(
  address: ServerAddress,
  settings: ReadyLine[],
  interfaces?: ReturnType<typeof networkInterfaces>,
  isGuestInterface?: (name: string) => boolean,
): ReadyLine[] {
  const network = networkUrls(address, interfaces, isGuestInterface);
  const hidden = network.length - MAX_NETWORK_URLS;
  return [
    {
      label: "Local",
      value: localUrl(address),
      isLink: true,
      isEssential: true,
    },
    ...network.slice(0, MAX_NETWORK_URLS).map((value) => ({
      label: "Network",
      value,
      isLink: true,
    })),
    ...(hidden > 0
      ? [
          {
            label: "Network",
            value: pluralize(hidden, "more address", "more addresses"),
          },
        ]
      : []),
    ...settings,
  ];
}

/**
 * Run the server until it exits, with its output on the terminal. Resolves
 * with its exit code; throws a `CliError` when it could not listen or start
 * Vite, and a
 * `CancelledError` naming the server and how long it ran when a signal
 * stopped it.
 */
export async function runServer(options: RunServerOptions): Promise<number> {
  const { name, script, cwd, env, mapPath, onReady } = options;
  let readyAt: number | undefined;
  let listenError: ListenError | undefined;
  let startError: StartError | undefined;
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
          startError ??= readStartError(message);
        });
      },
    );
    if (listenError) throw new CliError(describeListenError(listenError));
    if (startError) throw new CliError(describeStartError(startError, mapPath));
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
