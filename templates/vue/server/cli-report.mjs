import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";

const WILDCARD_ADDRESSES = ["0.0.0.0", "::"];

async function report(message, line, write) {
  if (!process.send) return write(line);
  await new Promise((sent) => process.send(message, () => sent()));
}

/**
 * The server answers at `address`:`port`.
 *
 * What the server tells whoever started it. Started by `ajs dms dev` or `ajs
 * dms start`, it reports over IPC and the CLI words what the user reads.
 * Started on its own, it prints the line itself.
 */
export async function reportReady(address, port) {
  const host = WILDCARD_ADDRESSES.includes(address)
    ? "localhost"
    : address.includes(":")
      ? `[${address}]`
      : address;
  await report(
    { type: "dms:ready", address, port },
    `✓ Server ready on http://${host}:${port}`,
    console.log,
  );
}

/**
 * The server cannot listen: a port taken by another process, an address this
 * host does not have. Reported instead of Node's unhandled-error dump, then
 * the server exits.
 */
export async function reportListenError(error, host, port) {
  await report(
    {
      type: "dms:listen-error",
      code: error.code,
      message: error.message,
      host,
      port,
    },
    `DMS server cannot listen on ${host}:${port}: ${error.message}`,
    console.error,
  );
  process.exit(1);
}

/** The `[PARSE_ERROR] ` Rolldown puts in front of what it says. */
const RULE_PREFIX = /^\[[A-Z_]+\]\s*/;

/** The first problem Rolldown reports when it cannot bundle a config. */
function bundlerError(error) {
  const first = error?.errors?.[0];
  return first && typeof first === "object" ? first : undefined;
}

/**
 * Where a startup error points, when it says: Rolldown's location for a config
 * it could not bundle (the line is read back from the file, which Rolldown
 * only draws in a colored frame), Rollup's for a plugin that failed on a file.
 */
function errorLocation(error) {
  const source = bundlerError(error) ?? error;
  const file = source?.loc?.file ?? source?.id;
  if (typeof file !== "string") return undefined;
  const { line, column } = source.loc ?? {};
  return {
    file: resolve(file),
    line,
    column,
    lineText: line === undefined ? undefined : readLine(file, line),
  };
}

/** Line `line` (1-based) of `file`, `undefined` when it cannot be read. */
function readLine(file, line) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/)[line - 1];
  } catch {
    return undefined;
  }
}

/** The first line of what went wrong, without Rolldown's rule and frame. */
function errorText(error) {
  const reported = bundlerError(error);
  const message = reported
    ? String(reported.message)
    : error instanceof Error
      ? error.message
      : String(error);
  return stripVTControlCharacters(message)
    .split(/\r?\n/)[0]
    .replace(RULE_PREFIX, "");
}

/**
 * Vite could not start, so no page can be served: the error and where it
 * points instead of a stack trace, then the server exits.
 */
export async function reportStartError(error) {
  const message = errorText(error);
  const location = errorLocation(error);
  const where = location
    ? `${location.file}${location.line ? `:${location.line}:${location.column ?? 0}` : ""}: `
    : "";
  await report(
    { type: "dms:start-error", message, code: error?.code, location },
    `DMS development server failed to start: ${where}${message}`,
    console.error,
  );
  process.exit(1);
}
