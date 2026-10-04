import * as assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertLayersSupportRenderer,
  type RendererRelease,
  type ResolvedLayer,
} from "../src/common";
import { problemText } from "./fixtures/memory-ui";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWN_PACKAGE: RendererRelease = JSON.parse(
  readFileSync(join(REPOSITORY, "package.json"), "utf8"),
);
const RENDERER = "@antelopejs/dms-frontend";
const EXCLUDING_EVERY_RELEASE = ">=999.0.0";

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
});

function temporaryDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function layerWith(name: string, engines?: Record<string, unknown>): string {
  const path = temporaryDir("dms-renderer-range-");
  const pkg: Record<string, unknown> = { name };
  if (engines) pkg.engines = engines;
  writeFileSync(join(path, "package.json"), JSON.stringify(pkg));
  return path;
}

function layer(name: string, engines?: Record<string, unknown>): ResolvedLayer {
  return { path: layerWith(name, engines), packageName: name };
}

function declaring(name: string, range: unknown): ResolvedLayer {
  return layer(name, { [RENDERER]: range });
}

function check(
  layers: ResolvedLayer[],
  version = "0.4.0",
  workspaceDir?: string,
): string[] {
  const warnings: string[] = [];
  assertLayersSupportRenderer(layers, {
    renderer: { name: RENDERER, version },
    warn: (text, { details = [] }) =>
      warnings.push([text, ...details].join("\n")),
    workspaceDir,
  });
  return warnings;
}

describe("renderer range", () => {
  it("accepts a module whose range allows this release", () => {
    assert.deepEqual(check([declaring("supported", ">=0.3.2 <0.5.0")]), []);
  });

  it("refuses a module whose range excludes this release, naming both", () => {
    assert.throws(
      () => check([declaring("@acme/dms-billing", ">=0.2.8 <0.4.0")]),
      (err: Error) => {
        assert.match(
          err.message,
          /do not run on @antelopejs\/dms-frontend 0\.4\.0/,
        );
        assert.match(
          problemText(err),
          /@acme\/dms-billing \(.+\) supports >=0\.2\.8 <0\.4\.0/,
        );
        return true;
      },
    );
  });

  it("names the modules before saying how to fix them", () => {
    const first = declaring("too-old", "<0.4.0");
    const second = declaring("too-new", ">=0.5.0");
    assert.throws(
      () => check([first, second]),
      (err: Error) => {
        assert.equal(
          problemText(err),
          [
            `✖ These frontend modules do not run on ${RENDERER} 0.4.0`,
            `  too-old (${first.path}) supports <0.4.0`,
            `  too-new (${second.path}) supports >=0.5.0`,
            `  → Install a ${RENDERER} release in their ranges, or upgrade the modules`,
            "",
          ].join("\n"),
        );
        return true;
      },
    );
  });

  it("names every module that does not support the release at once", () => {
    assert.throws(
      () =>
        check([
          declaring("too-old", "<0.4.0"),
          declaring("fine", "^0.4.0"),
          declaring("too-new", ">=0.5.0"),
        ]),
      (err: Error) => {
        const text = problemText(err);
        assert.match(text, /too-old \(.+\) supports <0\.4\.0/);
        assert.match(text, /too-new \(.+\) supports >=0\.5\.0/);
        assert.doesNotMatch(text, /fine/);
        return true;
      },
    );
  });

  it("refuses a range it cannot read rather than guessing", () => {
    for (const range of ["latest", 3, null]) {
      assert.throws(
        () => check([declaring(`unreadable-${String(range)}`, range)]),
        (err) => /declares an unreadable range/.test(problemText(err)),
      );
    }
  });

  it("loads a module that declares no range, naming it once", () => {
    const undeclared = layer("undeclared-module");
    assert.equal(check([undeclared]).length, 1);
    assert.deepEqual(check([undeclared]), []);
  });

  it("names a module once per workspace, across runs", () => {
    const workspace = temporaryDir("dms-renderer-range-workspace-");
    const noticed = join(workspace, ".renderer-range-noticed");
    const earlier = layer("noticed-by-an-earlier-run");
    writeFileSync(noticed, `noticed-by-an-earlier-run (${earlier.path})\n`);
    assert.deepEqual(check([earlier], "0.4.0", workspace), []);

    const added = layer("added-since");
    assert.equal(check([earlier, added], "0.4.0", workspace).length, 1);
    assert.deepEqual(readFileSync(noticed, "utf8").trim().split("\n").sort(), [
      `added-since (${added.path})`,
      `noticed-by-an-earlier-run (${earlier.path})`,
    ]);
  });

  it("tells apart two modules that share a package name", () => {
    const first = declaring("playground-frontend-vue", "<0.4.0");
    const second = declaring("playground-frontend-vue", "<0.4.0");
    assert.throws(
      () => check([first, second]),
      (err: Error) =>
        problemText(err).includes(`playground-frontend-vue (${first.path})`) &&
        problemText(err).includes(`playground-frontend-vue (${second.path})`),
    );
  });

  it("says where the missing range belongs", () => {
    const undeclared = layer("undeclared-hint", { node: ">=20" });
    const [warning] = check([undeclared]);
    assert.equal(
      warning,
      [
        `No supported ${RENDERER} range declared, so not checked against 0.4.0`,
        `undeclared-hint (${undeclared.path})`,
        `→ Declare one in its package.json, under engines["${RENDERER}"]`,
      ].join("\n"),
    );
  });

  it("names a module from its source, not from the archive it came in", () => {
    const source = temporaryDir("dms-renderer-range-source-");
    const archived = {
      ...declaring("archived", "<0.4.0"),
      sourcePath: source,
    };
    assert.throws(
      () => check([archived]),
      (err) =>
        problemText(err).includes(`archived (${source}) supports <0.4.0`),
    );
  });

  it("checks a prerelease as the release it leads to", () => {
    assert.throws(
      () => check([declaring("before-0.4", "<0.4.0")], "0.4.0-next.1"),
      (err) => /before-0\.4 \(.+\) supports <0\.4\.0/.test(problemText(err)),
    );
    assert.deepEqual(
      check([declaring("on-0.3", ">=0.3.2 <0.4.0")], "0.3.3-next.0"),
      [],
    );
  });

  it("checks against this package's own name and version by default", () => {
    const layers = [declaring("excluding-all", EXCLUDING_EVERY_RELEASE)];
    assert.throws(
      () => assertLayersSupportRenderer(layers),
      (err: Error) =>
        err.message.endsWith(
          `do not run on ${OWN_PACKAGE.name} ${OWN_PACKAGE.version}`,
        ),
    );
  });
});

interface Backend {
  server: Server;
  url: string;
}

function serveManifest(layerPath: string): Promise<Backend> {
  const manifest = {
    version: 1,
    archive: "/dms/frontend/modules",
    modules: [
      {
        name: "excluding-module",
        archiveName: "excluding-module",
        priority: 0,
        renderer: { name: "vue", version: "3" },
        path: layerPath,
      },
    ],
  };
  return new Promise((resolveBackend) => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(manifest));
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("No address");
      resolveBackend({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

interface Run {
  status: number | null;
  output: string;
}

interface RunOptions {
  env?: Record<string, string>;
  /** Home to run in, so a second run finds what the first one cached. */
  home?: string;
}

async function runTypeScript(
  entry: string,
  args: string[],
  {
    env = {},
    home = temporaryDir("dms-renderer-range-home-"),
  }: RunOptions = {},
): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", require.resolve("tsx"), join(REPOSITORY, entry), ...args],
      {
        cwd: home,
        env: { ...process.env, HOME: home, NO_UPDATE_NOTIFIER: "1", ...env },
      },
    );
    return { status: 0, output: `${stdout}${stderr}` };
  } catch (err: any) {
    return {
      status: err.code ?? 1,
      output: `${err.stdout ?? ""}${err.stderr ?? ""}`,
    };
  }
}

describe("commands refusing a module that does not support this release", () => {
  it("stops dev before the workspace is built, from a cached manifest too", async () => {
    const layerPath = layerWith("excluding-module", {
      [RENDERER]: EXCLUDING_EVERY_RELEASE,
    });
    const backend = await serveManifest(layerPath);
    const home = temporaryDir("dms-renderer-range-home-");
    const dev = ["dev", "-b", backend.url, "-p", "0"];
    try {
      for (const args of [dev, [...dev, "--offline"]]) {
        const { status, output } = await runTypeScript("src/index.ts", args, {
          home,
        });
        assert.equal(status, 1, output);
        assert.match(output, /✖ These frontend modules do not run on/);
        assert.doesNotMatch(output, /Setup failed/);
        assert.match(output, /excluding-module \(.+\) supports >=999\.0\.0/);
      }
      const workspaces = join(home, ".antelopejs", "dms-frontend");
      for (const workspace of readdirSync(workspaces))
        assert.equal(
          existsSync(join(workspaces, workspace, "frontend-modules")),
          false,
        );
    } finally {
      await closeServer(backend.server);
    }
  });

  it("stops verify-source before installing anything", async () => {
    const layerPath = layerWith("excluding-source", {
      [RENDERER]: EXCLUDING_EVERY_RELEASE,
    });
    writeFileSync(join(layerPath, "dms.frontend.ts"), "export default {};\n");
    const { status, output } = await runTypeScript(
      "src/verify-source-runner.ts",
      [],
      { env: { DMS_LAYER_SOURCE: layerPath } },
    );
    assert.equal(status, 1, output);
    assert.match(output, /✖ These frontend modules do not run on/);
    assert.match(output, /excluding-source \(.+\) supports >=999\.0\.0/);
    assert.doesNotMatch(output, /Generated workspace/);
    assert.doesNotMatch(output, /^\s+at /m, "no stack trace");
  });
});
