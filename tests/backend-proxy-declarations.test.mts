import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import { resolveBackendProxies } from "../templates/vue/server/backend-proxies.mjs";
import {
  environmentBackendProxies,
  readDeclaredBackendProxies,
} from "../templates/vue/server/public-endpoints.mjs";

const ENTRIES = JSON.stringify([
  { path: "/media/**", auth: "none", maxBodyBytes: 1024 },
  "/media",
  5,
  true,
  null,
  ["/x"],
  { path: 5 },
  { auth: "none" },
  { path: "/a", auth: "cookie" },
  { path: "/b", auth: null },
  { path: "/c", maxBodyBytes: "1" },
  { path: "/d" },
]);

function withWarnings<T>(run: () => T) {
  const warn = mock.method(console, "warn", () => undefined);
  try {
    const result = run();
    return {
      result,
      warnings: warn.mock.calls.map(({ arguments: [message] }) =>
        String(message),
      ),
    };
  } finally {
    warn.mock.restore();
  }
}

describe("backend proxy declarations of DMS_BACKEND_PROXIES", () => {
  it("keep the entries that name a path, with the variable as their declarer", () => {
    const { result, warnings } = withWarnings(() =>
      environmentBackendProxies(ENTRIES),
    );
    assert.deepEqual(result, [
      {
        path: "/media/**",
        auth: "none",
        maxBodyBytes: 1024,
        module: "DMS_BACKEND_PROXIES",
      },
      { path: "/d", module: "DMS_BACKEND_PROXIES" },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^Ignoring 10 entries of DMS_BACKEND_PROXIES/);
  });

  it("reach the routing with the same proxies as before", () => {
    const { result: manifest } = withWarnings(() =>
      environmentBackendProxies(ENTRIES),
    );
    const resolved = resolveBackendProxies([], manifest, () => undefined);
    assert.deepEqual(
      resolved.map((proxy) => [proxy.path, proxy.auth, proxy.maxBodyBytes]),
      [
        ["/d", "session", undefined],
        ["/media/**", "none", 1024],
      ],
    );
  });

  it("are ignored whole, with a reason, when they are not a JSON array", () => {
    for (const declaration of ["{}", "abc", "5", "null"]) {
      const { result, warnings } = withWarnings(() =>
        environmentBackendProxies(declaration),
      );
      assert.deepEqual(result, [], declaration);
      assert.deepEqual(warnings, [
        "Ignoring DMS_BACKEND_PROXIES: not a JSON array",
      ]);
    }
  });
});

describe("backend proxy declarations of the generated manifest file", () => {
  function declared(text: string) {
    const dir = mkdtempSync(join(tmpdir(), "dms-declared-proxies-"));
    try {
      const file = join(dir, "generated-public-endpoints.json");
      writeFileSync(file, text);
      return withWarnings(() => readDeclaredBackendProxies(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("keep the entries that name a path and say which module declared them", () => {
    const { result, warnings } = declared(
      JSON.stringify({
        proxies: [
          { module: "media", path: "/media/**", auth: "none" },
          { path: "/open" },
          { module: 5, path: "/x" },
          { module: "bad", path: "/y", auth: "cookie" },
          null,
          "/z",
        ],
      }),
    );
    assert.deepEqual(result, [
      { module: "media", path: "/media/**", auth: "none" },
      { path: "/open" },
    ]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^Ignoring 4 entries of the generated manifest/);
  });

  it("declare no proxy when the file is missing, broken or holds no list", () => {
    for (const text of ["", "{", "[]", "{}", '{"proxies":"/x"}', "null"]) {
      const { result, warnings } = declared(text);
      assert.deepEqual(result, [], text);
      assert.deepEqual(warnings, [], text);
    }
  });
});
