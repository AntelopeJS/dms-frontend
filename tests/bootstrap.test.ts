import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  normalizeBootstrapSecret,
  resolveBootstrapSecret,
} from "../src/common";
import {
  type DevHandshake,
  readDevBootstrapCredential,
} from "../src/discovery";

const alive = () => true;
const dead = () => false;

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BACKEND_PORT = 5010;
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

function makeProject(
  handshake?: DevHandshake | string,
  options: { port?: number; devRegistry?: boolean } = {},
): {
  root: string;
  nested: string;
} {
  const root = mkdtempSync(join(tmpdir(), "dms-bootstrap-"));
  cleanupDirs.push(root);
  const nested = join(root, "apps", "frontend");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(root, ".antelope"), { recursive: true });
  if (options.devRegistry !== false) {
    writeFileSync(
      join(root, ".antelope", "dev.json"),
      JSON.stringify({
        pid: process.pid,
        servers: {
          api: {
            endpoints: [
              {
                protocol: "http",
                host: "localhost",
                port: options.port ?? BACKEND_PORT,
              },
            ],
          },
        },
      }),
    );
  }
  if (handshake !== undefined) {
    writeFileSync(
      join(root, ".antelope", "dms-dev.json"),
      typeof handshake === "string"
        ? handshake
        : JSON.stringify(handshake, null, 2),
    );
  }
  return { root, nested };
}

const validHandshake: DevHandshake = {
  pid: process.pid,
  bootstrapSecret: "ephemeral-dev-secret",
  updatedAt: "2026-08-06T10:00:00Z",
};

describe("readDevBootstrapCredential", () => {
  it("reads the credential a live backend published", () => {
    const { root } = makeProject(validHandshake);
    assert.equal(
      readDevBootstrapCredential(root, { isPidAlive: alive }),
      "ephemeral-dev-secret",
    );
  });

  it("ignores the orphan a crashed backend left behind", () => {
    const { root } = makeProject(validHandshake);
    assert.equal(
      readDevBootstrapCredential(root, { isPidAlive: dead }),
      undefined,
    );
  });

  it("ignores an unparseable file", () => {
    const { root } = makeProject("{ not json");
    assert.equal(
      readDevBootstrapCredential(root, { isPidAlive: alive }),
      undefined,
    );
  });

  it("ignores a file with no credential in it", () => {
    const { root } = makeProject(JSON.stringify({ pid: process.pid }));
    assert.equal(
      readDevBootstrapCredential(root, { isPidAlive: alive }),
      undefined,
    );
  });

  it("ignores an empty credential", () => {
    const { root } = makeProject({ pid: process.pid, bootstrapSecret: "" });
    assert.equal(
      readDevBootstrapCredential(root, { isPidAlive: alive }),
      undefined,
    );
  });

  it("returns nothing when no backend published one", () => {
    const { root } = makeProject();
    assert.equal(
      readDevBootstrapCredential(root, { isPidAlive: alive }),
      undefined,
    );
  });
});

describe("normalizeBootstrapSecret", () => {
  it("trims a credential that kept its trailing newline", () => {
    assert.equal(normalizeBootstrapSecret("  secret\n"), "secret");
  });

  it("treats a blank value as no credential at all", () => {
    assert.equal(normalizeBootstrapSecret("   "), undefined);
    assert.equal(normalizeBootstrapSecret(undefined), undefined);
  });

  it("names the problem for a credential that cannot travel in a header", () => {
    assert.throws(
      () => normalizeBootstrapSecret("bad\rvalue"),
      /cannot travel in an HTTP header/,
    );
    assert.throws(() => normalizeBootstrapSecret("séance"), /HTTP header/);
  });

  it("names where the credential came from", () => {
    assert.throws(
      () =>
        normalizeBootstrapSecret("bad\rvalue", "/proj/.antelope/dms-dev.json"),
      /Check \/proj\/\.antelope\/dms-dev\.json/,
    );
  });
});

describe("resolveBootstrapSecret", () => {
  it("prefers an explicit credential over any local handshake", () => {
    const { nested } = makeProject(validHandshake);
    assert.equal(
      resolveBootstrapSecret("explicit", BACKEND_URL, {
        cwd: nested,
        isPidAlive: alive,
      }),
      "explicit",
    );
  });

  it("walks up from a nested directory to the project that published it", () => {
    const { nested } = makeProject(validHandshake);
    assert.equal(
      resolveBootstrapSecret(undefined, BACKEND_URL, {
        cwd: nested,
        isPidAlive: alive,
      }),
      "ephemeral-dev-secret",
    );
  });

  it("presents the discovered credential to the backend that published it, however the URL is spelled", () => {
    const { root } = makeProject(validHandshake);
    assert.equal(
      resolveBootstrapSecret(undefined, `http://127.0.0.1:${BACKEND_PORT}/`, {
        cwd: root,
        isPidAlive: alive,
      }),
      "ephemeral-dev-secret",
    );
  });

  it("never sends a local credential to a backend that did not publish it", () => {
    const { root } = makeProject(validHandshake);
    assert.equal(
      resolveBootstrapSecret(undefined, "https://staging.example.com", {
        cwd: root,
        isPidAlive: alive,
      }),
      undefined,
    );
  });

  it("withholds it from another instance of the same host on a different port", () => {
    const { root } = makeProject(validHandshake);
    assert.equal(
      resolveBootstrapSecret(undefined, "http://localhost:5020", {
        cwd: root,
        isPidAlive: alive,
      }),
      undefined,
    );
  });

  it("ignores a handshake whose backend is no longer running", () => {
    const { root } = makeProject(validHandshake);
    assert.equal(
      resolveBootstrapSecret(undefined, BACKEND_URL, {
        cwd: root,
        isPidAlive: dead,
      }),
      undefined,
    );
  });

  it("returns nothing outside any antelope project", () => {
    const outside = mkdtempSync(join(tmpdir(), "dms-no-project-"));
    cleanupDirs.push(outside);
    assert.equal(
      resolveBootstrapSecret(undefined, BACKEND_URL, {
        cwd: outside,
        isPidAlive: alive,
      }),
      undefined,
    );
  });

  it("holds a malformed published credential to the same standard", () => {
    // The backend publishes its configured frontend.bootstrapSecret when one is
    // set, so a malformed value can arrive this way too.
    const { root } = makeProject({
      pid: process.pid,
      bootstrapSecret: "has a space",
    });
    assert.throws(
      () =>
        resolveBootstrapSecret(undefined, BACKEND_URL, {
          cwd: root,
          isPidAlive: alive,
        }),
      /cannot travel in an HTTP header/,
    );
  });

  it("does not treat a bare .antelope build directory as the project root", () => {
    const { root } = makeProject(validHandshake);
    const inner = join(root, "packages", "inner");
    mkdirSync(join(inner, ".antelope", "build"), { recursive: true });
    assert.equal(
      resolveBootstrapSecret(undefined, BACKEND_URL, {
        cwd: inner,
        isPidAlive: alive,
      }),
      "ephemeral-dev-secret",
    );
  });
});
