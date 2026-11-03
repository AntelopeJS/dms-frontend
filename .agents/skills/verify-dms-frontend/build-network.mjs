import { createConnection } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * @param {number} port A port
 * @param {string} host An address
 * @returns {Promise<boolean>} Whether a connection is accepted
 */
export function accepts(port, host) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

/**
 * @returns {string[]} The non-loopback IPv4 addresses of this machine
 */
export function lanAddresses() {
  return Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}
