import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  fetchLatestVersionFromRegistry,
  isUpdateCheckEnabled,
  startUpdateCheck,
  stripUpdateCheckFlag,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_PACKAGE,
  UPDATE_CHECK_RETRY_INTERVAL_MS,
  type UpdateCheckOptions,
  updateCheckCacheFile,
} from "../src/update-check";
import { DMS_FRONTEND_HOME } from "../src/config";
import { memoryUi } from "./fixtures/memory-ui";

function cacheFile(): string {
  return join(
    mkdtempSync(join(tmpdir(), "dms-update-check-")),
    "nested",
    "state.json",
  );
}

/** The notice as a finished command ends on it, set apart from its output. */
function notice(latestVersion: string): string[] {
  return [
    "",
    `ℹ ajs dms ${latestVersion} is available (you have 0.0.1) → ajs update dms`,
  ];
}

interface Harness {
  written: string[];
  fetched: string[];
  /** Starts a check, lets its lookup settle, then reports it. */
  run: (overrides?: Partial<UpdateCheckOptions>) => Promise<void>;
  options: (overrides?: Partial<UpdateCheckOptions>) => UpdateCheckOptions;
  cacheFile: string;
}

function harness(latestVersion?: string, now = 1_000_000): Harness {
  const written: string[] = [];
  const fetched: string[] = [];
  const file = cacheFile();
  const options = (overrides: Partial<UpdateCheckOptions> = {}) => ({
    currentVersion: "0.0.1",
    argv: ["dev"],
    env: {},
    isTerminal: true,
    now: () => now,
    cacheFile: file,
    fetchLatestVersion: async (packageName: string) => {
      fetched.push(packageName);
      return latestVersion;
    },
    ui: memoryUi().ui,
    write: (line: string) => written.push(line),
    ...overrides,
  });
  return {
    written,
    fetched,
    cacheFile: file,
    options,
    run: async (overrides) => {
      const check = startUpdateCheck(options(overrides));
      await check?.completion;
      await check?.report();
    },
  };
}

describe("update check opt-outs", () => {
  it("runs for a regular invocation", () => {
    assert.equal(isUpdateCheckEnabled(["dev", "-b", "http://x"], {}), true);
  });

  it("stays silent for --help, -h, --version, -v and help", () => {
    for (const argv of [
      ["--help"],
      ["dev", "--help"],
      ["-h"],
      ["--version"],
      ["-v"],
      ["help", "dev"],
    ]) {
      assert.equal(isUpdateCheckEnabled(argv, {}), false, argv.join(" "));
    }
  });

  it("stays silent for --json, whose stdout a script parses", () => {
    assert.equal(isUpdateCheckEnabled(["workspaces", "--json"], {}), false);
  });

  it("honours CI, NO_UPDATE_NOTIFIER, TERM=dumb and --no-update-check", () => {
    assert.equal(isUpdateCheckEnabled(["dev"], { CI: "true" }), false);
    assert.equal(isUpdateCheckEnabled(["dev"], { TERM: "dumb" }), false);
    assert.equal(
      isUpdateCheckEnabled(["dev"], { NO_UPDATE_NOTIFIER: "1" }),
      false,
    );
    assert.equal(isUpdateCheckEnabled(["dev", "--no-update-check"], {}), false);
  });

  it("stays silent in a quiet run, whatever the position of -q", () => {
    for (const argv of [
      ["-q", "dev"],
      ["dev", "-q"],
      ["dev", "--quiet"],
    ]) {
      assert.equal(isUpdateCheckEnabled(argv, {}), false, argv.join(" "));
    }
    assert.equal(
      isUpdateCheckEnabled(["dev"], { ANTELOPEJS_QUIET: "1" }),
      false,
    );
    for (const value of ["0", "false", ""]) {
      assert.equal(
        isUpdateCheckEnabled(["dev"], { ANTELOPEJS_QUIET: value }),
        true,
        value,
      );
    }
  });

  it("removes the opt-out flag from the arguments Commander parses", () => {
    assert.deepEqual(
      stripUpdateCheckFlag(["dev", "--no-update-check", "-b", "http://x"]),
      ["dev", "-b", "http://x"],
    );
  });

  it("leaves the spelling alone past `--` or as an option value", () => {
    for (const argv of [
      ["dev", "--", "--no-update-check"],
      ["dev", "-b", "--no-update-check"],
      ["verify-source", "-l", "--no-update-check"],
    ]) {
      assert.deepEqual(stripUpdateCheckFlag(argv), argv, argv.join(" "));
      assert.equal(isUpdateCheckEnabled(argv, {}), true, argv.join(" "));
    }
  });

  it("ignores --help and --version past `--` or as an option value", () => {
    assert.equal(isUpdateCheckEnabled(["dev", "--", "--help"], {}), true);
    assert.equal(isUpdateCheckEnabled(["dev", "-b", "--version"], {}), true);
  });
});

describe("update check cache location", () => {
  it("lives in the loader home, next to the workspaces", () => {
    const file = updateCheckCacheFile();
    assert.equal(file, join(DMS_FRONTEND_HOME, "update-check.json"));
    assert.match(file, /\.antelopejs\/dms-frontend\/update-check\.json$/);
  });
});

describe("update check notice", () => {
  it("reports a newer release last, in the core style, and caches it", async () => {
    const test = harness("0.1.0");
    await test.run();

    assert.deepEqual(test.fetched, [UPDATE_CHECK_PACKAGE]);
    assert.deepEqual(test.written, notice("0.1.0"));
    assert.deepEqual(JSON.parse(readFileSync(test.cacheFile, "utf-8")), {
      checkedAt: 1_000_000,
      latestVersion: "0.1.0",
      succeeded: true,
    });
  });

  it("stays silent when the published version is not newer", async () => {
    const test = harness("0.0.1");
    await test.run();
    assert.deepEqual(test.written, []);
  });

  it("skips the registry within the interval but still reminds", async () => {
    const test = harness("0.2.0", 1_000_000);
    await test.run();
    test.written.length = 0;
    test.fetched.length = 0;

    await test.run({ now: () => 1_000_000 + 60_000 });

    assert.deepEqual(test.fetched, []);
    assert.deepEqual(test.written, notice("0.2.0"));
  });

  it("checks the registry again once the interval has elapsed", async () => {
    const test = harness("0.2.0", 1_000_000);
    await test.run();
    test.fetched.length = 0;

    await test.run({ now: () => 1_000_000 + UPDATE_CHECK_INTERVAL_MS });

    assert.deepEqual(test.fetched, [UPDATE_CHECK_PACKAGE]);
  });

  it("stamps the cache when the lookup fails, keeping the known version", async () => {
    const test = harness("0.4.0", 1_000_000);
    await test.run();
    test.written.length = 0;

    const later = 1_000_000 + UPDATE_CHECK_INTERVAL_MS;
    await test.run({
      now: () => later,
      fetchLatestVersion: async () => undefined,
    });

    assert.deepEqual(JSON.parse(readFileSync(test.cacheFile, "utf-8")), {
      checkedAt: later,
      latestVersion: "0.4.0",
      succeeded: false,
    });
    assert.deepEqual(test.written, notice("0.4.0"));
  });

  it("stamps a bare attempt when nothing was ever published", async () => {
    const test = harness();
    await test.run({ fetchLatestVersion: async () => undefined });

    assert.deepEqual(JSON.parse(readFileSync(test.cacheFile, "utf-8")), {
      checkedAt: 1_000_000,
      succeeded: false,
    });
    assert.deepEqual(test.written, []);

    test.fetched.length = 0;
    await test.run({ now: () => 1_000_000 + 60_000 });
    assert.deepEqual(test.fetched, [], "the failed attempt throttles the next");
  });

  it("retries a failed lookup after the back-off instead of a day later", async () => {
    const test = harness("0.5.0", 1_000_000);
    await test.run({ fetchLatestVersion: async () => undefined });
    test.fetched.length = 0;

    const retry = 1_000_000 + UPDATE_CHECK_RETRY_INTERVAL_MS;
    assert.ok(
      UPDATE_CHECK_RETRY_INTERVAL_MS < UPDATE_CHECK_INTERVAL_MS,
      "a failure must not buy as much silence as a success",
    );
    await test.run({ now: () => retry });

    assert.deepEqual(test.fetched, [UPDATE_CHECK_PACKAGE]);
    assert.deepEqual(test.written, notice("0.5.0"));
  });

  it("keeps a successful lookup throttled for the whole day", async () => {
    const test = harness("0.5.0", 1_000_000);
    await test.run();
    test.fetched.length = 0;

    await test.run({ now: () => 1_000_000 + UPDATE_CHECK_RETRY_INTERVAL_MS });

    assert.deepEqual(test.fetched, []);
  });

  it("retries a failure that followed a success, keeping the notice going", async () => {
    const test = harness("0.6.0", 1_000_000);
    await test.run();
    const failedAt = 1_000_000 + UPDATE_CHECK_INTERVAL_MS;
    await test.run({
      now: () => failedAt,
      fetchLatestVersion: async () => undefined,
    });
    test.fetched.length = 0;

    await test.run({ now: () => failedAt + UPDATE_CHECK_RETRY_INTERVAL_MS });

    assert.deepEqual(test.fetched, [UPDATE_CHECK_PACKAGE]);
  });

  it("retries a cache written before the outcome was recorded", async () => {
    // The shape a failed first lookup left on disk: a timestamp and nothing
    // else. Read as a success it would silence the notice for a full day.
    const test = harness("0.7.0", 1_000_000);
    mkdirSync(dirname(test.cacheFile), { recursive: true });
    writeFileSync(test.cacheFile, JSON.stringify({ checkedAt: 1_000_000 }));

    await test.run({ now: () => 1_000_000 + 60_000 });
    assert.deepEqual(test.fetched, [], "still throttled inside the back-off");

    await test.run({ now: () => 1_000_000 + UPDATE_CHECK_RETRY_INTERVAL_MS });
    assert.deepEqual(test.fetched, [UPDATE_CHECK_PACKAGE]);
    assert.deepEqual(test.written, notice("0.7.0"));
  });

  it("never throws when the registry fails, hangs or answers nonsense", async () => {
    const test = harness();
    await test.run({
      fetchLatestVersion: async () => {
        throw new Error("ENOTFOUND registry.npmjs.org");
      },
    });
    await test.run({ fetchLatestVersion: async () => undefined });
    await test.run({ fetchLatestVersion: async () => "not-a-version" });
    assert.deepEqual(test.written, []);
  });

  it("survives an unreadable cache file", async () => {
    const test = harness("0.3.0");
    await test.run({ cacheFile: "/proc/version/impossible.json" });
    assert.deepEqual(test.written, notice("0.3.0"));
  });
});

/** Writes the cache a lookup at `checkedAt` left behind. */
function seedCache(file: string, checkedAt: number, latestVersion: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ checkedAt, latestVersion, succeeded: true }),
  );
}

describe("update check timing and placement", () => {
  it("starts the lookup as the check starts, before the command runs", () => {
    const test = harness("0.1.0");
    startUpdateCheck(test.options());
    assert.deepEqual(test.fetched, [UPDATE_CHECK_PACKAGE]);
  });

  it("stays silent and offline when stderr is not a terminal", async () => {
    const test = harness("0.1.0");
    assert.equal(
      startUpdateCheck(test.options({ isTerminal: false })),
      undefined,
    );
    assert.deepEqual(test.fetched, []);
  });

  it("prints the notice once, however often it is reported", async () => {
    const test = harness("0.1.0");
    const check = startUpdateCheck(test.options());
    await check?.completion;
    await check?.report({ isFollowed: true });
    await check?.report();
    assert.equal(test.written.length, 2);
  });

  it("never waits for a lookup still in flight", async () => {
    const test = harness();
    seedCache(test.cacheFile, 1_000_000 - UPDATE_CHECK_INTERVAL_MS, "0.8.0");
    let answer: (version: string) => void = () => undefined;
    const check = startUpdateCheck(
      test.options({
        fetchLatestVersion: () =>
          new Promise<string>((settle) => {
            answer = settle;
          }),
      }),
    );

    await check?.report();
    assert.deepEqual(test.written, notice("0.8.0"), "the version known so far");

    answer("0.9.0");
    await check?.completion;
    assert.equal(
      JSON.parse(readFileSync(test.cacheFile, "utf-8")).latestVersion,
      "0.9.0",
      "the answer is kept for the next run",
    );
  });

  it("prints nothing before the first lookup answered", async () => {
    const test = harness();
    const check = startUpdateCheck(
      test.options({ fetchLatestVersion: () => new Promise(() => undefined) }),
    );
    await check?.report();
    assert.deepEqual(test.written, []);
  });

  it("sets the notice apart from the server output that follows it", async () => {
    const test = harness("0.1.0");
    const check = startUpdateCheck(test.options());
    await check?.completion;
    await check?.report({ isFollowed: true });
    assert.deepEqual(test.written, [...notice("0.1.0").reverse()]);
  });

  it("wraps the notice to the terminal, under its text", async () => {
    const test = harness("0.1.0");
    await test.run({ columns: 40 });
    assert.deepEqual(test.written, [
      "",
      "ℹ ajs dms 0.1.0 is available (you have",
      "  0.0.1) → ajs update dms",
    ]);
  });

  it("falls back to ASCII and colors only the symbol and the command", async () => {
    const ascii = harness("0.1.0");
    await ascii.run({ ui: memoryUi({ isUnicode: false }).ui });
    assert.deepEqual(ascii.written, [
      "",
      "i ajs dms 0.1.0 is available (you have 0.0.1) > ajs update dms",
    ]);

    const colored = harness("0.1.0");
    await colored.run({ ui: memoryUi({ isColored: true }).ui });
    assert.equal(
      colored.written[1],
      "\x1b[34mℹ\x1b[39m ajs dms 0.1.0 is available (you have 0.0.1) " +
        "\x1b[36m→ ajs update dms\x1b[39m",
    );
  });
});

interface RegistryStub {
  url: string;
  requests: IncomingMessage[];
  close: () => Promise<void>;
}

async function registryStub(
  respond: (request: IncomingMessage) => { status: number; body: string },
): Promise<RegistryStub> {
  const requests: IncomingMessage[] = [];
  const server: Server = createServer((request, response) => {
    requests.push(request);
    const { status, body } = respond(request);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("registry lookup", () => {
  it("reads the version off the scoped package's latest dist-tag", async () => {
    const stub = await registryStub(() => ({
      status: 200,
      body: JSON.stringify({ name: UPDATE_CHECK_PACKAGE, version: "9.9.9" }),
    }));
    try {
      const version = await fetchLatestVersionFromRegistry(
        UPDATE_CHECK_PACKAGE,
        stub.url,
      );
      assert.equal(version, "9.9.9");
      assert.equal(stub.requests[0]?.url, "/@antelopejs%2fdms-frontend/latest");
      // The abbreviated packument type earns a 406 on this endpoint.
      assert.equal(stub.requests[0]?.headers.accept, "application/json");
    } finally {
      await stub.close();
    }
  });

  it("returns undefined for a non-200 answer", async () => {
    const stub = await registryStub(() => ({ status: 404, body: "{}" }));
    try {
      assert.equal(
        await fetchLatestVersionFromRegistry(UPDATE_CHECK_PACKAGE, stub.url),
        undefined,
      );
    } finally {
      await stub.close();
    }
  });

  it("returns undefined for a body that is not a version", async () => {
    const stub = await registryStub(() => ({ status: 200, body: "not json" }));
    try {
      assert.equal(
        await fetchLatestVersionFromRegistry(UPDATE_CHECK_PACKAGE, stub.url),
        undefined,
      );
    } finally {
      await stub.close();
    }
  });

  it("gives up on the deadline rather than on socket inactivity", async () => {
    const stalled = createServer(() => {
      // Accept the request and answer nothing, the captive-portal shape a
      // per-socket inactivity timer would never fire on.
    });
    await new Promise<void>((resolve) =>
      stalled.listen(0, "127.0.0.1", resolve),
    );
    const { port } = stalled.address() as AddressInfo;
    const started = Date.now();
    try {
      assert.equal(
        await fetchLatestVersionFromRegistry(
          UPDATE_CHECK_PACKAGE,
          `http://127.0.0.1:${port}/`,
          80,
        ),
        undefined,
      );
      assert.ok(
        Date.now() - started < 2000,
        "the deadline must fire well before any default timeout",
      );
    } finally {
      stalled.closeAllConnections();
      await new Promise<void>((resolve) => stalled.close(() => resolve()));
    }
  });

  it("treats a redirect as no answer instead of following it", async () => {
    const stub = await registryStub(() => ({
      status: 301,
      body: JSON.stringify({ version: "9.9.9" }),
    }));
    try {
      assert.equal(
        await fetchLatestVersionFromRegistry(UPDATE_CHECK_PACKAGE, stub.url),
        undefined,
      );
    } finally {
      await stub.close();
    }
  });

  it("returns undefined when the registry cannot be reached", async () => {
    const stub = await registryStub(() => ({ status: 200, body: "{}" }));
    const url = stub.url;
    await stub.close();
    assert.equal(
      await fetchLatestVersionFromRegistry(UPDATE_CHECK_PACKAGE, url),
      undefined,
    );
  });
});
