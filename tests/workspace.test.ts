import * as assert from "node:assert/strict";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  assertLayerPathsServed,
  canonicalizeBackendUrl,
  computeDepsHash,
  directorySize,
  getWorkspaceDir,
  getWorkspaceDirForKey,
  type Manifest,
  type ManifestModule,
  projectWorkspaceKey,
  readCachedManifest,
} from "../src/common";
import { CliError } from "@antelopejs/core/cli";
import { problemText } from "./fixtures/memory-ui";

describe("dependency fingerprint", () => {
  it("changes when the generated workspace dependencies change", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-deps-"));
    const layer = mkdtempSync(join(tmpdir(), "dms-layer-"));
    cleanupDirs.push(workspace, layer);
    writeFileSync(join(layer, "package.json"), '{"name":"layer"}');
    const workspacePackage = join(workspace, "package.json");
    writeFileSync(workspacePackage, '{"dependencies":{"vue":"3"}}');
    const before = computeDepsHash([layer], workspacePackage);
    writeFileSync(workspacePackage, '{"dependencies":{"vue":"4"}}');
    assert.notEqual(computeDepsHash([layer], workspacePackage), before);
  });

  it("changes when a dependency patch or the pnpm workspace config changes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-deps-"));
    cleanupDirs.push(workspace);
    const workspacePackage = join(workspace, "package.json");
    const pnpmConfig = join(workspace, "pnpm-workspace.yaml");
    const patch = join(workspace, "ui.patch");
    writeFileSync(workspacePackage, "{}");
    writeFileSync(pnpmConfig, "packages: ['.']");
    writeFileSync(patch, "-old");
    const inputs = [pnpmConfig, patch];
    const before = computeDepsHash([], workspacePackage, inputs);
    writeFileSync(patch, "+new");
    const patched = computeDepsHash([], workspacePackage, inputs);
    assert.notEqual(patched, before);
    writeFileSync(pnpmConfig, "packages: ['.']\npatchedDependencies: {}");
    assert.notEqual(computeDepsHash([], workspacePackage, inputs), patched);
  });
});

describe("workspace identity", () => {
  it("keeps the same workspace for a project whatever the backend port", () => {
    const key = projectWorkspaceKey("/home/user/my-project");
    assert.equal(getWorkspaceDirForKey(key), getWorkspaceDirForKey(key));
    assert.notEqual(
      getWorkspaceDir("http://localhost:5010"),
      getWorkspaceDir("http://localhost:5011"),
    );
  });

  it("gives distinct workspaces to distinct project paths", () => {
    assert.notEqual(
      getWorkspaceDirForKey(projectWorkspaceKey("/home/user/worktree-a")),
      getWorkspaceDirForKey(projectWorkspaceKey("/home/user/worktree-b")),
    );
  });

  it("shares one workspace between build, start, clean and dev -b", () => {
    const spellings = [
      "http://localhost:5010",
      "http://localhost:5010/",
      "HTTP://LOCALHOST:5010",
      "http://127.0.0.1:5010",
      "  http://127.0.0.1:5010  ",
    ];
    const dirs = new Set(spellings.map((url) => getWorkspaceDir(url)));
    assert.equal(dirs.size, 1);
    assert.equal(
      getWorkspaceDirForKey(canonicalizeBackendUrl("http://localhost:5010/")),
      getWorkspaceDir("http://127.0.0.1:5010"),
    );
  });

  it("never collides a project key with a backend URL key", () => {
    assert.notEqual(
      getWorkspaceDirForKey(projectWorkspaceKey("/http://localhost:5010")),
      getWorkspaceDir("http://localhost:5010"),
    );
  });
});

const cleanupDirs: string[] = [];
after(() => {
  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const cachedManifest: Manifest = {
  modules: [
    {
      name: "@scope/dms-frontend-module",
      path: "/srv/layers/dms",
      priority: 0,
      privateOptions: { oauth: { relaySecret: "s3cret" } },
    },
  ],
};

function makeWorkspace(cacheFile: string): string {
  const dir = mkdtempSync(join(tmpdir(), "dms-workspace-"));
  cleanupDirs.push(dir);
  writeFileSync(join(dir, ".manifest-cache.json"), cacheFile);
  return dir;
}

describe("workspace size", () => {
  it("counts a hard-linked file once and never follows a symbolic link", () => {
    const outside = mkdtempSync(join(tmpdir(), "dms-store-"));
    const workspace = mkdtempSync(join(tmpdir(), "dms-workspace-"));
    cleanupDirs.push(outside, workspace);
    writeFileSync(join(outside, "big"), Buffer.alloc(4096));
    mkdirSync(join(workspace, "node_modules"));
    writeFileSync(join(workspace, "node_modules", "a.js"), Buffer.alloc(100));
    linkSync(
      join(workspace, "node_modules", "a.js"),
      join(workspace, "node_modules", "b.js"),
    );
    symlinkSync(outside, join(workspace, "node_modules", "linked"));
    const linkSize = Buffer.byteLength(outside);
    assert.equal(directorySize(workspace), 100 + linkSize);
  });
});

describe("manifest cache", () => {
  it("survives the credential rotating between runs", () => {
    const dir = makeWorkspace(
      JSON.stringify(
        { manifest: cachedManifest, fetchedAt: "2026-08-06T10:00:00Z" },
        null,
        2,
      ),
    );
    assert.deepEqual(readCachedManifest(dir)?.manifest, cachedManifest);
  });

  it("ignores a file that is not a cache entry", () => {
    assert.equal(
      readCachedManifest(makeWorkspace(JSON.stringify({ nope: 1 }, null, 2))),
      undefined,
    );
  });
});

describe("layer paths withheld by the backend", () => {
  const backendUrl = "http://127.0.0.1:5010";
  const pathless: ManifestModule[] = [
    { name: "@scope/dms-frontend-module", priority: 0 },
    { name: "@scope/other-module", priority: 0 },
  ];

  function messageFor(
    bootstrapSecret?: string,
    cache?: { fetchedAt?: string },
  ): string {
    try {
      assertLayerPathsServed(pathless, backendUrl, { bootstrapSecret, cache });
    } catch (err) {
      assert.ok(err instanceof CliError);
      return problemText(err);
    }
    assert.fail("expected the pathless manifest to be refused");
  }

  it("names the backend and counts the modules instead of listing them", () => {
    const message = messageFor();
    assert.match(
      message,
      /^✖ The backend at http:\/\/127\.0\.0\.1:5010 did not send layer source paths \(2 of 2 modules\)\n/,
    );
    assert.doesNotMatch(message, /@scope\//);
  });

  it("names the missing credential when the run sent none", () => {
    const message = messageFor();
    assert.match(message, /this run sent none/);
    assert.match(message, /\.antelope\/dms-dev\.json/);
    assert.match(message, /DMS_BOOTSTRAP_SECRET/);
    assert.match(message, /ajs dms build/);
  });

  it("names the refused credential when the run sent one", () => {
    const message = messageFor("a-credential");
    assert.match(message, /did not accept the one this run sent/);
    assert.doesNotMatch(message, /sent none/);
  });

  it("does not speak for one command, since dev and prepare share it", () => {
    assert.doesNotMatch(messageFor(), /ajs dms dev/);
  });

  it("blames the run that cached the manifest when this run sent nothing", () => {
    const fetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    for (const bootstrapSecret of [undefined, "a-credential"]) {
      const message = messageFor(bootstrapSecret, { fetchedAt });
      assert.match(
        message,
        /^✖ The cached manifest of http:\/\/127\.0\.0\.1:5010 \(fetched 5 min ago\) has no layer source paths \(2 of 2 modules\)\n {2}This run did not fetch it\./,
      );
      assert.doesNotMatch(message, /this run sent|did not accept/);
      assert.match(message, /→ Run once without --offline/);
      assert.match(message, /ajs dms build/);
    }
    assert.match(
      messageFor(undefined, {}),
      /^✖ The cached manifest of http:\/\/127\.0\.0\.1:5010 has no layer/,
    );
  });

  it("accepts a manifest whose modules all have a path", () => {
    assert.doesNotThrow(() =>
      assertLayerPathsServed(
        [{ ...pathless[0], path: "/layers/a" }],
        backendUrl,
      ),
    );
  });
});
