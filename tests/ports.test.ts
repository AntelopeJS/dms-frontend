import * as assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { describe, it } from "node:test";
import { reserveFreePort } from "../src/ports";

function occupyPort(port = 0): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port }, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("No address"));
        return;
      }
      resolve({ server, port: address.port });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe("reserveFreePort", () => {
  it("returns the requested port when it is free", async () => {
    // Grab an ephemeral port then release it: it is almost certainly
    // still free when we probe it right after.
    const { server, port } = await occupyPort();
    await closeServer(server);
    const reserved = await reserveFreePort(port);
    try {
      assert.equal(reserved.port, port);
    } finally {
      await reserved.release();
    }
  });

  it("falls back to a later port when the requested one is busy", async () => {
    const { server, port } = await occupyPort();
    try {
      const reserved = await reserveFreePort(port);
      try {
        assert.notEqual(reserved.port, port);
        assert.ok(reserved.port > port && reserved.port <= port + 20);
      } finally {
        await reserved.release();
      }
    } finally {
      await closeServer(server);
    }
  });

  it("holds the port until release() is called", async () => {
    const { server, port } = await occupyPort();
    await closeServer(server);

    const first = await reserveFreePort(port);
    // While the first reservation is held, a second one must skip past it.
    const second = await reserveFreePort(port);
    try {
      assert.equal(first.port, port);
      assert.notEqual(second.port, port);
    } finally {
      await second.release();
    }

    // Once released, the port is reservable again.
    await first.release();
    const again = await reserveFreePort(port);
    try {
      assert.equal(again.port, port);
    } finally {
      await again.release();
    }
  });

  it("throws when no port is free within the range", async () => {
    const { server, port } = await occupyPort();
    try {
      await assert.rejects(
        () => reserveFreePort(port, 0),
        /No free port found between/,
      );
    } finally {
      await closeServer(server);
    }
  });

  it("clamps the probe range to the TCP maximum", async () => {
    // Whatever the local state of ports 65530-65535, the result must
    // never exceed the TCP maximum (without the clamp, the loop would
    // probe invalid port numbers and report a bogus upper bound).
    try {
      const reserved = await reserveFreePort(65530, 20);
      try {
        assert.ok(reserved.port <= 65535);
      } finally {
        await reserved.release();
      }
    } catch (err: any) {
      assert.match(err.message, /between 65530 and 65535/);
    }
  });
});
