// What the server tells whoever started it. Started by `ajs dms dev` or
// `ajs dms start`, it reports over IPC and the CLI words what the user reads.
// Started on its own, it prints the line itself.

import { resolve } from "node:path";

const WILDCARD_ADDRESSES = ["0.0.0.0", "::"];

async function report(message, line, write) {
  if (!process.send) return write(line);
  await new Promise((sent) => process.send(message, () => sent()));
}

/** The server answers at `address`:`port`. */
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

/**
 * Where a startup error points, when it says: esbuild's location for a config
 * it could not bundle, Rollup's for a plugin that failed on a file.
 */
function errorLocation(error) {
  const location = error?.errors?.[0]?.location;
  if (location?.file) {
    return {
      file: resolve(location.file),
      line: location.line,
      column: location.column,
      lineText: location.lineText,
    };
  }
  const file = error?.loc?.file ?? error?.id;
  if (typeof file !== "string") return undefined;
  return { file, line: error.loc?.line, column: error.loc?.column };
}

/** The first line of what went wrong, without esbuild's error count. */
function errorText(error) {
  const text = error?.errors?.[0]?.text;
  if (typeof text === "string") return text;
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/)[0];
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
