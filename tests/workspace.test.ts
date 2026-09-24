import * as assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  buildLayersFromPaths,
  canonicalizeBackendUrl,
  computeDepsHash,
  describeWorkspace,
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

describe("renderer dependency patches", () => {
  it("declares every shipped patch and ships every declared one", () => {
    const template = join("templates", "vue");
    const shipped = readdirSync(join(template, "patches"))
      .map((name) => `patches/${name}`)
      .sort();
    const config = readFileSync(join(template, "pnpm-workspace.yaml"), "utf8");
    const declared = [...config.matchAll(/^\s+"[^"]+":\s*(patches\/\S+)$/gm)]
      .map((match) => match[1])
      .sort();
    assert.ok(shipped.length > 0);
    assert.deepEqual(declared, shipped);
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

  it("shares one workspace between build, start, clean and dev -b", () => {
    // `build`, `start` and `clean` all key on `getWorkspaceDir`, and `dev`
    // falls back to the same canonical URL key as soon as -b is given; the
    // command name and the dev/build mode are deliberately not in the hash,
    // so a single backend is built and served out of a single workspace.
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

  it("names the project a dev workspace is keyed on", () => {
    // `dev` without -b intentionally does NOT share the URL-keyed workspace,
    // so `clean --all` has to say which of the two it is removing.
    assert.equal(
      describeWorkspace({
        dir: "/home/user/.antelopejs/dms-frontend/abc",
        backendUrl: "http://127.0.0.1:5010",
        workspaceKey: projectWorkspaceKey("/home/user/my-project"),
      }),
      "http://127.0.0.1:5010, keyed on project /home/user/my-project",
    );
    assert.equal(
      describeWorkspace({
        dir: "/home/user/.antelopejs/dms-frontend/abc",
        backendUrl: "http://127.0.0.1:5010",
        workspaceKey: canonicalizeBackendUrl("http://127.0.0.1:5010"),
      }),
      "http://127.0.0.1:5010",
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
