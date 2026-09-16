import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildBackendUrl,
  type DevRegistry,
  discoverBackend,
} from "../src/discovery";

const alive = () => true;
const dead = () => false;

function makeProject(registry?: DevRegistry | string): {
  root: string;
  nested: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dms-discovery-"));
  cleanupDirs.push(root);
  const nested = join(root, "apps", "frontend");
  mkdirSync(nested, { recursive: true });
  if (registry !== undefined) {
    mkdirSync(join(root, ".antelope"), { recursive: true });
    writeFileSync(
      join(root, ".antelope", "dev.json"),
      typeof registry === "string"
        ? registry
        : JSON.stringify(registry, null, 2),
    );
  }
  return { root, nested };
}

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const validRegistry: DevRegistry = {
  pid: process.pid,
  startedAt: "2026-06-12T10:00:00Z",
  servers: {
    api: {
      endpoints: [{ protocol: "http", host: "localhost", port: 5011 }],
    },
  },
};

describe("discoverBackend", () => {
  it("finds the registry by walking up from a nested cwd", () => {
    const { root, nested } = makeProject(validRegistry);
    const result = discoverBackend(nested, { isPidAlive: alive });
    assert.equal(result.status, "found");
    if (result.status === "found") {
      assert.equal(result.backend.projectDir, root);
      assert.equal(result.backend.backendUrl, "http://localhost:5011");
      assert.equal(result.backend.registry.pid, process.pid);
    }
  });

  it("returns not-found when no dev.json exists up the tree", () => {
    const { nested } = makeProject(undefined);
    const result = discoverBackend(nested, { isPidAlive: alive });
    assert.equal(result.status, "not-found");
  });

  it("reports a stale registry when the writer pid is dead", () => {
    const { root, nested } = makeProject(validRegistry);
    const result = discoverBackend(nested, { isPidAlive: dead });
    assert.equal(result.status, "stale");
    if (result.status === "stale") {
      assert.equal(result.projectDir, root);
      assert.equal(result.pid, process.pid);
    }
  });

  it("reports a live registry without an api endpoint", () => {
    const { root, nested } = makeProject({
      pid: process.pid,
      servers: { other: { endpoints: [] } },
    });
    const result = discoverBackend(nested, { isPidAlive: alive });
    assert.equal(result.status, "no-api-endpoint");
    if (result.status === "no-api-endpoint") {
      assert.equal(result.projectDir, root);
    }
  });

  it("reports a malformed dev.json instead of falling through to a parent", () => {
    const { root, nested } = makeProject("{not json");
    const result = discoverBackend(nested, { isPidAlive: alive });
    assert.equal(result.status, "malformed");
    if (result.status === "malformed") {
      assert.equal(result.projectDir, root);
    }
  });

  it("normalizes wildcard bind hosts to localhost and brackets IPv6", () => {
    assert.equal(
      buildBackendUrl({ protocol: "http", host: "0.0.0.0", port: 5010 }),
      "http://localhost:5010",
    );
    assert.equal(
      buildBackendUrl({ protocol: "http", host: "::", port: 5010 }),
      "http://localhost:5010",
    );
    assert.equal(
      buildBackendUrl({ protocol: "http", host: "::1", port: 5010 }),
      "http://[::1]:5010",
    );
    assert.equal(
      buildBackendUrl({ protocol: "http", host: "192.168.1.10", port: 5010 }),
      "http://192.168.1.10:5010",
    );
  });
});
