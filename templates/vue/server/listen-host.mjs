const LOOPBACK = "127.0.0.1";
const EVERY_INTERFACE = "0.0.0.0";

/**
 * `HOST` when set. Otherwise the development server (`ajs dms dev`) listens
 * on the loopback address only: it serves the sources, the modules' server
 * code and its own error overlays, which nobody else on the network should
 * reach. `HOST=0.0.0.0` opens it to them. A production server listens on
 * every interface, as a container expects.
 *
 * The address the frontend server listens on.
 *
 * @param env The server's environment
 */
export function listenHost(env = process.env) {
  const host = env.HOST?.trim();
  if (host) return host;
  return env.DMS_DEV === "true" ? LOOPBACK : EVERY_INTERFACE;
}
