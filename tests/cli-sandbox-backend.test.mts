import * as assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { describe, it } from "node:test";
import { addressOf } from "./helpers/net";
import {
  runCli,
  BACKEND_URL,
  SESSION_SECRET,
  builtWorkspace,
  listenOnFreePort,
  closeServer,
} from "./fixtures/cli-sandbox.mts";

describe("reporting what the verify-source runner found", () => {
  it("sends a package without package.json back as a usage error", async () => {
    const result = await runCli(["verify-source", "-l", "packages"], {
      files: { "packages/broken/dms.frontend.ts": "export default {};\n" },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✖ No package\.json in \.\/packages\/broken\n {2}→ Pass the root of a DMS frontend package/,
    );
    assert.doesNotMatch(
      result.stderr,
      /ENOENT|Error:|^\s+at |Source verification failed/m,
    );
  });

  it("names a directory without any package", async () => {
    const result = await runCli(["verify-source", "-l", "empty"], {
      files: { "empty/README.md": "" },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /^✖ No frontend package in \.\/empty\n/);
  });

  it("sends a frontend module passed with -l to -m", async () => {
    const result = await runCli(["verify-source", "-l", "frontend-vue"], {
      files: {
        "frontend-vue/package.json": JSON.stringify({ name: "demo-frontend" }),
        "frontend-vue/dms.frontend.ts": "export default {};\n",
      },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /^✖ \.\/frontend-vue is not the DMS core layer\n/,
    );
    assert.match(
      result.stderr,
      /\n {2}→ Drop -l and pass the folder with -m: ajs dms verify-source -m \.\/frontend-vue\n$/,
    );
    assert.doesNotMatch(result.stderr, /Materializ|ApexCharts|node_modules/);
  });

  it("asks to install @antelopejs/dms when the project has none", async () => {
    const result = await runCli(["verify-source", "-m", "frontend-vue"], {
      files: {
        "package.json": JSON.stringify({ name: "demo" }),
        "frontend-vue/package.json": JSON.stringify({ name: "demo-frontend" }),
        "frontend-vue/dms.frontend.ts": "export default {};\n",
      },
    });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(
      result.stderr,
      "✖ @antelopejs/dms is not installed in this project\n" +
        "  Frontend modules are verified on top of the DMS core layer that @antelopejs/dms ships, and Node finds no @antelopejs/dms from the current directory.\n" +
        "  → Add it as a development dependency: pnpm add -D @antelopejs/dms\n",
    );
  });
});

describe("explaining an unreachable backend", () => {
  async function closedBackendUrl(): Promise<string> {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    return `http://127.0.0.1:${port}`;
  }

  it("names the URL and the cause in dev and prepare", async () => {
    const backendUrl = await closedBackendUrl();
    for (const command of ["dev", "prepare"]) {
      const result = await runCli([command, "-b", backendUrl], {
        env: { DMS_SESSION_SECRET: SESSION_SECRET },
      });
      assert.equal(result.code, command === "prepare" ? 0 : 1, command);
      assert.match(
        result.stderr,
        new RegExp(
          `\n(✖|▲ Skipped prepare:) Cannot reach the DMS backend at ${backendUrl}\n`,
        ),
        command,
      );
      assert.doesNotMatch(result.stderr, /Setup failed/);
      assert.match(result.stderr, /Connection refused \(ECONNREFUSED\)\./);
      assert.match(result.stderr, /→ Start the backend/);
      assert.doesNotMatch(result.stderr, /fetch failed/);
    }
  });
});

describe("telling a skipped prepare from a failed one", () => {
  const STRICT_HINT =
    /\n {2}prepare never fails an install; add --strict to make this an error\.\n$/;

  async function closedBackendUrl(): Promise<string> {
    const { server, port } = await listenOnFreePort();
    await closeServer(server);
    return `http://127.0.0.1:${port}`;
  }

  /** A backend answering every request with `status` and `body`. */
  async function withBackend(
    status: number,
    body: string,
    run: (backendUrl: string) => Promise<void>,
  ): Promise<void> {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    });
    await new Promise<void>((settle) =>
      server.listen({ port: 0, host: "127.0.0.1" }, settle),
    );
    const address = addressOf(server);
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise((settle) => server.close(settle));
    }
  }

  it("skips without a backend URL, and needs one with --strict", async () => {
    const skipped = await runCli(["prepare"]);
    assert.equal(skipped.code, 0);
    assert.match(skipped.stderr, /^▲ Skipped prepare: no backend URL\n/);
    assert.match(skipped.stderr, STRICT_HINT);

    const strict = await runCli(["prepare", "--strict"]);
    assert.equal(strict.code, 2);
    assert.equal(strict.stdout, "");
    assert.match(strict.stderr, /^✖ Backend URL is required\n/);
  });

  it("reads --strict from DMS_PREPARE_STRICT, in the environment or ./.env", async () => {
    const fromEnv = await runCli(["prepare"], {
      env: { DMS_PREPARE_STRICT: "1" },
    });
    assert.equal(fromEnv.code, 2);
    const fromFile = await runCli(["prepare"], {
      files: { ".env": "DMS_PREPARE_STRICT=true\n" },
    });
    assert.equal(fromFile.code, 2);
    for (const value of ["0", "false", "off", ""]) {
      const off = await runCli(["prepare"], {
        env: { DMS_PREPARE_STRICT: value },
      });
      assert.equal(off.code, 0, value);
    }
  });

  it("skips while the backend is out of reach, and fails with --strict", async () => {
    const backendUrl = await closedBackendUrl();
    const skipped = await runCli(["prepare", "-b", backendUrl]);
    assert.equal(skipped.code, 0);
    assert.match(
      skipped.stderr,
      /▲ Skipped prepare: Cannot reach the DMS backend/,
    );
    assert.match(
      skipped.stderr,
      /\n {2}The types and the module registry were not generated\.\n/,
    );
    assert.match(skipped.stderr, STRICT_HINT);

    const strict = await runCli(["prepare", "-b", backendUrl, "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /\n✖ Cannot reach the DMS backend at /);
    assert.doesNotMatch(strict.stderr, /Skipped prepare|--strict/);
  });

  it("skips offline without a cached manifest, and fails with --strict", async () => {
    const args = ["prepare", "-b", BACKEND_URL, "--offline"];
    const skipped = await runCli(args);
    assert.equal(skipped.code, 0);
    assert.match(
      skipped.stderr,
      /▲ Skipped prepare: No cached manifest for this workspace\n/,
    );

    const strict = await runCli([...args, "--strict"]);
    assert.equal(strict.code, 1);
    assert.match(strict.stderr, /✖ No cached manifest for this workspace\n/);
  });

  it("reports a refused credential as a failure, an error with --strict", async () => {
    await withBackend(401, "{}", async (backendUrl) => {
      const env = { DMS_BOOTSTRAP_SECRET: undefined };
      const failed = await runCli(["prepare", "-b", backendUrl], { env });
      assert.equal(failed.code, 0);
      assert.equal(failed.stdout, "");
      assert.match(
        failed.stderr,
        /▲ Prepare failed: The backend requires a bootstrap credential \(401\)/,
      );
      assert.match(failed.stderr, /→ Production\/CI: set DMS_BOOTSTRAP_SECRET/);
      assert.match(failed.stderr, STRICT_HINT);

      const strict = await runCli(["prepare", "-b", backendUrl, "--strict"], {
        env,
      });
      assert.equal(strict.code, 1);
      assert.match(
        strict.stderr,
        /\n✖ The backend requires a bootstrap credential \(401\)/,
      );
    });
  });

  it("reports an incompatible manifest as a failure, an error with DMS_PREPARE_STRICT", async () => {
    await withBackend(
      200,
      JSON.stringify({ version: 3, modules: [] }),
      async (backendUrl) => {
        const args = ["prepare", "-b", backendUrl];
        const failed = await runCli(args);
        assert.equal(failed.code, 0);
        assert.match(
          failed.stderr,
          /▲ Prepare failed: The backend serves frontend manifest version 3, which @antelopejs\/dms-frontend \S+ cannot read\n/,
        );

        const strict = await runCli(args, { env: { DMS_PREPARE_STRICT: "1" } });
        assert.equal(strict.code, 1);
        assert.match(
          strict.stderr,
          /\n✖ The backend serves frontend manifest version 3, which @antelopejs\/dms-frontend \S+ cannot read\n {2}This loader reads version 2; the backend's @antelopejs\/dms is newer than this loader\.\n {2}→ Upgrade the loader \(ajs update dms\) to a release that reads version 3\n/,
        );

        const off = await runCli(args, { env: { DMS_PREPARE_STRICT: "0" } });
        assert.equal(off.code, 0);
      },
    );
  });
});

/**
 * `start` is the cheapest command that proves a variable reached Commander:
 * from a built project it touches no network, and names the URL it resolved
 * in its header.
 */

describe("loading the project .env", () => {
  const ENV_ONLY = {
    DMS_API_BASE_URL: undefined,
    DMS_SESSION_SECRET: "configured-session-secret-at-least-32-characters",
    PORT: "0",
  };
  const startedFor = (port: number) =>
    new RegExp(`^ajs dms start {2}http://127\\.0\\.0\\.1:${port} · `);

  it("fills a variable the environment does not define", async () => {
    const result = await runCli(["start"], {
      files: {
        ...builtWorkspace(),
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
      },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Backend URL is required/);
    assert.match(result.stderr, startedFor(5010));
  });

  it("lets a real environment variable win over the .env", async () => {
    const result = await runCli(["start"], {
      files: {
        ...builtWorkspace(),
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
      },
      env: { ...ENV_ONLY, DMS_API_BASE_URL: "http://127.0.0.1:5999" },
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, startedFor(5999));
    assert.doesNotMatch(result.stderr, /5010/);
  });

  it("lets .env.local win over .env", async () => {
    const result = await runCli(["start"], {
      files: {
        ...builtWorkspace(),
        ".env": "DMS_API_BASE_URL=http://127.0.0.1:5010\n",
        ".env.local": "DMS_API_BASE_URL=http://127.0.0.1:5011\n",
      },
      env: ENV_ONLY,
    });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stderr, startedFor(5011));
  });

  it("runs normally in a directory with no .env", async () => {
    const result = await runCli(["start"], { env: ENV_ONLY });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Backend URL is required/);
  });

  it("documents the .env contract in the environment topic", async () => {
    const result = await runCli(["help", "environment"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /then \.\/\.env\.local, then \.\/\.env\)/);
    assert.match(
      result.stdout,
      /set in the shell wins over both files, and \.env\.local wins over \.env/,
    );
  });
});

/** A workspace stamped as the loader stamps one, holding `bytes` of files. */
