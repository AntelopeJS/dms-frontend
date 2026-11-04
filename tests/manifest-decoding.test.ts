import * as assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  fetchManifest,
  ManifestRefusedError,
  readCachedManifest,
  writeCachedManifest,
} from "../src/common";
import { problemText } from "./fixtures/memory-ui";
import { closeServer, startBackend } from "./helpers/manifest-backend";

const vueModule = {
  name: "vue-module",
  priority: 0,
  renderer: { name: "vue", version: "3" },
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

async function manifestFailure(answer: Json): Promise<Error | undefined> {
  const { server, baseUrl } = await startBackend(200, JSON.stringify(answer));
  try {
    await fetchManifest(baseUrl);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err : undefined;
  } finally {
    await closeServer(server);
  }
}

describe("fetchManifest decoding", () => {
  it("refuses an answer that is not a manifest object, as one without a version", async () => {
    for (const body of [null, "abc", 5, true, [], {}]) {
      const failure = await manifestFailure(body);
      assert.ok(failure instanceof ManifestRefusedError, JSON.stringify(body));
      assert.match(
        problemText(failure),
        /^✖ The backend served a frontend manifest without a protocol version\n/,
      );
    }
  });

  it("refuses a manifest whose version is not a number", async () => {
    const failure = await manifestFailure({ version: "2", modules: [] });
    assert.ok(failure instanceof ManifestRefusedError);
    assert.match(problemText(failure), /without a protocol version/);
  });

  it("refuses a manifest without a list of modules", async () => {
    for (const modules of [undefined, null, "abc", 5, {}]) {
      const failure = await manifestFailure({ version: 2, modules });
      assert.ok(
        failure instanceof ManifestRefusedError,
        JSON.stringify(modules),
      );
      assert.match(problemText(failure), /modules/);
    }
  });

  it("refuses a module that is not an object, or has no name or priority", async () => {
    for (const bad of [
      null,
      "abc",
      5,
      [],
      { priority: 0, renderer: vueModule.renderer },
      { ...vueModule, name: 5 },
      { ...vueModule, priority: "1" },
      { name: "no-priority", renderer: vueModule.renderer },
    ]) {
      const failure = await manifestFailure({
        version: 2,
        modules: [vueModule, bad],
      });
      assert.ok(failure instanceof ManifestRefusedError, JSON.stringify(bad));
    }
  });

  it("refuses a module field of the wrong type instead of passing it on", async () => {
    for (const field of [
      { path: 5 },
      { configKey: [] },
      { options: "x" },
      { options: null },
      { privateOptions: [1] },
      { authEstablishEndpoints: "/api/auth" },
      { authEstablishEndpoints: [5] },
      { publicEndpoints: [null] },
      { publicEndpoints: [{ path: 5 }] },
      { backendProxies: [{ path: "/x", auth: "other" }] },
      { backendProxies: [{ path: "/x", maxBodyBytes: "1" }] },
    ]) {
      const failure = await manifestFailure({
        version: 2,
        modules: [{ ...vueModule, ...field }],
      });
      assert.ok(failure instanceof ManifestRefusedError, JSON.stringify(field));
    }
  });

  it("refuses a settling flag or origin rewrites of the wrong type", async () => {
    for (const extra of [
      { settling: "yes" },
      { originRewrites: {} },
      { originRewrites: [{ from: "http://a" }] },
    ]) {
      const failure = await manifestFailure({
        version: 2,
        modules: [vueModule],
        ...extra,
      });
      assert.ok(failure instanceof ManifestRefusedError, JSON.stringify(extra));
    }
  });

  it("keeps every field a well-formed manifest declares", async () => {
    const module = {
      ...vueModule,
      path: "/srv/module",
      options: { title: "Site", nested: { list: [1, "a", null, true] } },
      privateOptions: { secret: "s" },
      configKey: "site",
      authEstablishEndpoints: ["/api/auth/establish"],
      publicEndpoints: [
        {
          path: "/api/hooks/*",
          methods: ["POST"],
          headers: ["x-hook-secret"],
        },
      ],
      backendProxies: [{ path: "/media/**", auth: "none", maxBodyBytes: 10 }],
    };
    const body = {
      version: 2,
      modules: [module],
      settling: true,
      originRewrites: [{ from: "http://a", to: "http://b" }],
    };
    const { server, baseUrl } = await startBackend(200, JSON.stringify(body));
    try {
      assert.deepEqual(await fetchManifest(baseUrl), {
        modules: [module],
        settling: true,
        originRewrites: body.originRewrites,
      });
    } finally {
      await closeServer(server);
    }
  });

  it("does not take a cache that is not a manifest for the backend's", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "dms-manifest-cache-"));
    try {
      writeFileSync(
        join(workspace, ".manifest-cache.json"),
        JSON.stringify({ manifest: { modules: "abc" }, fetchedAt: "now" }),
      );
      assert.equal(readCachedManifest(workspace), undefined);
      writeFileSync(
        join(workspace, ".manifest-cache.json"),
        JSON.stringify({ manifest: { modules: [vueModule] } }),
      );
      assert.equal(readCachedManifest(workspace), undefined);
      writeCachedManifest(workspace, { modules: [vueModule] }, "then");
      assert.deepEqual(readCachedManifest(workspace), {
        manifest: { modules: [vueModule] },
        fetchedAt: "then",
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
