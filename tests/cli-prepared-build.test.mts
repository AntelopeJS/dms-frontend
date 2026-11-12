import * as assert from "node:assert/strict";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { FakePnpmCli, projectHome } from "./fixtures/fake-pnpm-cli.mts";

const INSTALL = ["install", "--reporter=append-only"];
const BUNDLES = [
  "build:client",
  "build:compress",
  "build:ssr",
  "build:email",
  "build:server",
].map((script) => ["--silent", "run", script]);

/** The fake pnpm is a shell script, like the one cli-signals puts on PATH. */
const describePosix = process.platform === "win32" ? describe.skip : describe;

void describePosix("build --setup-only and build --prepared", () => {
  let cli: FakePnpmCli;
  before(() => {
    cli = new FakePnpmCli("dms-frontend-prepared-");
  });
  after(() => cli.dispose());

  /** A project whose workspace `--setup-only` set up and installed. */
  async function setUp(): Promise<string> {
    const run = await cli.run(["build", "--setup-only"], {
      setUp: projectHome,
    });
    assert.equal(run.code, 0, run.stderr);
    return run.sandbox;
  }

  void it("--setup-only installs the workspace and bundles nothing", async () => {
    const run = await cli.run(["build", "--setup-only"], {
      setUp: projectHome,
    });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      run.calls.map((call) => call.args),
      [INSTALL],
    );
    assert.match(
      run.stderr,
      /\nSet up the production workspace → \.\/\.dms-frontend · \S+\n\nNext steps\n {2}ajs dms build --prepared {2}builds this workspace as it is\n$/,
    );
  });

  void it("--prepared bundles the workspace without setting it up or reading the project again", async () => {
    const sandbox = await setUp();
    rmSync(join(sandbox, "antelope.config.ts"));

    const run = await cli.run(["build", "--prepared"], { sandbox });

    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(
      run.calls.map((call) => call.args),
      BUNDLES,
    );
    assert.doesNotMatch(
      run.stderr,
      /Setting up the workspace|Workspace (?:ready|generated)/,
    );
    assert.match(run.stderr, /\nBuilt the production frontend → /);
  });

  void it("--prepared bundles once the module sources moved or changed after the setup", async () => {
    const moved = await setUp();
    renameSync(join(moved, "frontend-vue"), join(moved, "moved-away"));
    const edited = await setUp();
    writeFileSync(
      join(edited, "frontend-vue/package.json"),
      JSON.stringify({ name: "framed-layer", dependencies: { vue: "3" } }),
    );

    for (const sandbox of [moved, edited]) {
      const run = await cli.run(["build", "--prepared"], { sandbox });

      assert.equal(run.code, 0, run.stderr);
      assert.deepEqual(
        run.calls.map((call) => call.args),
        BUNDLES,
      );
    }
  });

  void it("--prepared points a failed step at the module's own file", async () => {
    const sandbox = await setUp();

    const run = await cli.run(["build", "--prepared"], {
      sandbox,
      scenario: "ssr-fails",
    });

    assert.equal(run.code, 1);
    assert.match(
      run.stderr,
      /✖ Vite could not compile \.\/frontend-vue\/app\/components\/Callout\.vue:10:50\n/,
    );
    assert.doesNotMatch(run.stderr, /frontend-modules/);
  });

  void it("--prepared refuses a workspace no setup made, exit 3, before any bundle", async () => {
    const run = await cli.run(["build", "--prepared"], {
      setUp: projectHome,
    });

    assert.equal(run.code, 3);
    assert.deepEqual(run.calls, []);
    assert.match(
      run.stderr,
      /✖ \.\/\.dms-frontend is not prepared\n {2}No production setup finished in it\.\n {2}→ Run ajs dms build --setup-only first, or build without --prepared\n$/,
    );
  });

  void it("--setup-only --no-install writes the workspace, which --prepared refuses until it is installed", async () => {
    const written = await cli.run(["build", "--setup-only", "--no-install"], {
      setUp: projectHome,
    });
    assert.equal(written.code, 0, written.stderr);
    assert.deepEqual(written.calls, []);
    assert.match(
      written.stderr,
      /\nWrote the production workspace without installing it → \.\/\.dms-frontend · \S+\n\nNext steps\n {2}ajs dms build --setup-only {2}installs its dependencies\n$/,
    );

    const refused = await cli.run(["build", "--prepared"], {
      sandbox: written.sandbox,
    });
    assert.equal(refused.code, 3);
    assert.match(
      refused.stderr,
      /Its dependencies are not installed, or changed since they were\./,
    );
  });

  void it("--prepared refuses an installed workspace a --no-install setup rewrote for new dependencies", async () => {
    const sandbox = await setUp();
    writeFileSync(
      join(sandbox, "frontend-vue/package.json"),
      JSON.stringify({ name: "framed-layer", dependencies: { vue: "3" } }),
    );
    const rewritten = await cli.run(["build", "--setup-only", "--no-install"], {
      sandbox,
    });
    assert.equal(rewritten.code, 0, rewritten.stderr);

    const run = await cli.run(["build", "--prepared"], { sandbox });

    assert.equal(run.code, 3);
    assert.deepEqual(run.calls, []);
  });

  void it("a setup that fails leaves a workspace --prepared refuses", async () => {
    const sandbox = await setUp();
    const failed = await cli.run(["build", "--setup-only", "--force"], {
      sandbox,
      scenario: "install-fails",
    });
    assert.equal(failed.code, 1);

    const run = await cli.run(["build", "--prepared"], { sandbox });

    assert.equal(run.code, 3);
    assert.deepEqual(run.calls, []);
  });

  void it("names the workspace a --workspace setup made in the step that follows", async () => {
    const run = await cli.run(
      ["build", "--setup-only", "--workspace", "out/web"],
      { setUp: projectHome },
    );

    assert.equal(run.code, 0, run.stderr);
    assert.match(
      run.stderr,
      / {2}ajs dms build --prepared --workspace out\/web {2}builds this workspace as it is\n$/,
    );
    const built = await cli.run(
      ["build", "--prepared", "--workspace", "out/web"],
      { sandbox: run.sandbox },
    );
    assert.equal(built.code, 0, built.stderr);
  });

  for (const [args, problem] of [
    [["--no-install"], /✖ --no-install needs --setup-only\n/],
    [
      ["--prepared", "--setup-only"],
      /✖ Option '--prepared' cannot be used with option '--setup-only'\n/,
    ],
    [
      ["--prepared", "--force"],
      /✖ Option '--prepared' cannot be used with option '-f, --force'\n/,
    ],
  ] as const) {
    void it(`refuses build ${args.join(" ")} as a usage error`, async () => {
      const run = await cli.run(["build", ...args], { setUp: projectHome });

      assert.equal(run.code, 2);
      assert.match(run.stderr, problem);
      assert.deepEqual(run.calls, []);
    });
  }
});
