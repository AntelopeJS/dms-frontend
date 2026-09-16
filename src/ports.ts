import { createServer, type Server } from "node:net";

// ============================================================================
// Frontend port reservation
// ============================================================================

/**
 * How many consecutive ports we try after the requested one before
 * giving up.
 */
export const PORT_FALLBACK_RANGE = 20;

const MAX_TCP_PORT = 65535;

/**
 * A port we are actively holding with a bound socket. Keeping the socket
 * open between the probe and the hand-off to the frontend server
 * shrinks the bind-probe-then-use race to the instant between
 * `release()` and the server's own bind — instead of spanning the whole
 * manifest fetch and workspace setup.
 */
export interface ReservedPort {
  port: number;
  /** Close the holding socket; call right before the real user binds. */
  release: () => Promise<void>;
}

/**
 * Bind without a host so a process listening on
 * any interface counts as a conflict.
 */
function tryListen(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(undefined));
    server.listen({ port }, () => resolve(server));
  });
}

/**
 * Reserve the port the dev server should use: the requested port if free,
 * otherwise the next free one up to `preferred + range` (clamped to the
 * TCP maximum). We probe ourselves instead of letting the frontend server fall back
 * silently — ajs-dms must know the real port, since it is sent to the
 * backend as the manifest's `clientUrl`.
 */
export async function reserveFreePort(
  preferred: number,
  range: number = PORT_FALLBACK_RANGE,
): Promise<ReservedPort> {
  const end = Math.min(preferred + range, MAX_TCP_PORT);
  for (let port = preferred; port <= end; port++) {
    const server = await tryListen(port);
    if (server) {
      return {
        port,
        release: () =>
          new Promise((resolve) => {
            server.close(() => resolve());
          }),
      };
    }
  }
  throw new Error(`No free port found between ${preferred} and ${end}.`);
}
