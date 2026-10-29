import assert from "node:assert/strict";
import type { AddressInfo, Server } from "node:net";

function isAddressInfo(
  address: ReturnType<Server["address"]>,
): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

/** Where a server that listens on a TCP port is bound. */
export function addressOf(server: Server): AddressInfo {
  const address = server.address();
  assert.ok(isAddressInfo(address));
  return address;
}

/** Where a server is bound, or nothing when it listens on a pipe or not at all. */
export function boundAddress(server: Server): AddressInfo | undefined {
  const address = server.address();
  return isAddressInfo(address) ? address : undefined;
}
