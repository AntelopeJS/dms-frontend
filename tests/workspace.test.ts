import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildLayersFromPaths,
  computeDepsHash,
  getWorkspaceDir,
  getWorkspaceDirForKey,
  type Manifest,
  type ManifestModule,
  projectWorkspaceKey,
  readCachedManifest,
} from "../src/common";

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
});

describe("workspace identity", () => {
  it("keeps the same workspace for a project whatever the backend port", () => {
    const key = projectWorkspaceKey("/home/user/my-project");
    assert.equal(getWorkspaceDirForKey(key), getWorkspaceDirForKey(key));
    // URL-keyed workspaces, by contrast, change with the port — the very
    // behavior autodiscovery mode avoids.
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

  it("never collides a project key with a backend URL key", () => {
    // A pathological project path that *looks* like a URL still maps to a
    // different workspace than the URL itself, thanks to the `project:`
    // prefix.
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
  pack: "/dms/modules",
  modules: [
    {
      name: "@scope/dms-frontend-module",
      archiveName: "@scope-dms-frontend-module",
      path: "/srv/layers/dms",
      priority: 0,
      privateOptions: { oauth: { relaySecret: "s3cret" } },
    },
  ],
};

function makeWorkspace(entry: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "dms-workspace-"));
  cleanupDirs.push(dir);
  writeFileSync(
    join(dir, ".manifest-cache.json"),
    JSON.stringify(entry, null, 2),
  );
  return dir;
}

describe("manifest cache", () => {
  it("survives the credential rotating between runs", () => {
    // A development backend mints a new secret on every boot. Binding the
    // entry to the credential would make --offline and the
    // unreachable-backend replay unusable from the second run onward.
    const dir = makeWorkspace({
      manifest: cachedManifest,
      fetchedAt: "2026-08-06T10:00:00Z",
    });
    assert.equal(readCachedManifest(dir)?.manifest.pack, cachedManifest.pack);
  });

  it("ignores a file that is not a cache entry", () => {
    assert.equal(readCachedManifest(makeWorkspace({ nope: 1 })), undefined);
  });
});

describe("layer paths withheld by the backend", () => {
  const pathless: ManifestModule[] = [
    { name: "@scope/dms-frontend-module", archiveName: "a", priority: 0 },
  ];

  it("explains what dev mode needs instead of failing obscurely", () => {
    assert.throws(
      () => buildLayersFromPaths(pathless),
      (err: Error) => {
        assert.match(err.message, /without layer source paths/);
        assert.match(err.message, /ajs project dev/);
        assert.match(err.message, /DMS_BOOTSTRAP_SECRET/);
        return true;
      },
    );
  });

  it("names the layer whose path is missing", () => {
    assert.throws(
      () => buildLayersFromPaths(pathless),
      /@scope\/dms-frontend-module/,
    );
  });
});
