import { type AddressInfo, createServer, type Server } from "node:net";
import { CliError } from "@antelopejs/core/cli";

// ============================================================================
// Frontend port reservation
// ============================================================================

/**
 * How many consecutive ports we try after the requested one before
 * giving up.
 */
export const PORT_FALLBACK_RANGE = 20;

export const MAX_TCP_PORT = 65535;

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
 *
 * The holder only reserves the port: it drops every connection it accepts.
 * `server.close()` waits for the accepted connections to end, so a client
 * left connected to the held port (a browser tab, a startup probe) would
 * otherwise keep `release()` pending and the frontend server would never
 * start.
 */
function tryListen(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.unref();
    server.once("error", () => resolve(undefined));
    server.listen({ port }, () => resolve(server));
  });
}

/**
 * Reserve the port the dev server should use: the requested port if free,
 * otherwise the next free one up to `preferred + range` (clamped to the
 * TCP maximum). We probe ourselves instead of letting the frontend server fall back
 * silently — ajs dms must know the real port, since it is sent to the
 * backend as the manifest's `clientUrl`.
 */
export async function reserveFreePort(
  preferred: number,
  range: number = PORT_FALLBACK_RANGE,
): Promise<ReservedPort> {
  const end = Math.min(preferred + range, MAX_TCP_PORT);
  for (let port = preferred; port <= end; port++) {
    const reserved = await reservePort(port);
    if (reserved) return reserved;
  }
  throw new CliError({
    title: `No free port found between ${preferred} and ${end}`,
    fixes: ["Free one of these ports, or pass another one: -p <port>"],
  });
}

/**
 * Reserve exactly `port`, for a server that must not move elsewhere: the
 * production server's port is the one the deployment routes traffic to.
 *
 * @returns The reservation, or undefined when the port is in use
 */
export async function reservePort(
  port: number,
): Promise<ReservedPort | undefined> {
  const server = await tryListen(port);
  if (!server) return undefined;
  return {
    port: (server.address() as AddressInfo).port,
    release: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}
