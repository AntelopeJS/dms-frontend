// What the server tells whoever started it. Started by `ajs dms dev` or
// `ajs dms start`, it reports over IPC and the CLI words what the user reads.
// Started on its own, it prints the line itself.

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
