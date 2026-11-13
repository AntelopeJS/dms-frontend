import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectManifestSecrets,
  describeSecretSources,
  formatSecretConflicts,
  MANIFEST_SECRET_ENV,
  reportManifestSecrets,
  resolveManifestSecrets,
} from "../src/manifest-secrets";
import type { FrontendModuleValue, ManifestModule } from "../src/workspace";
import { memoryUi } from "./fixtures/memory-ui";

const MANIFEST_SECRET = "manifest-render-secret";
const RELAY_SECRET = "manifest-relay-secret";

function dmsModule(
  serviceSecret: FrontendModuleValue,
  relaySecret: FrontendModuleValue = RELAY_SECRET,
  overrides: Partial<ManifestModule> = {},
): ManifestModule {
  return {
    name: "@antelopejs/dms-frontend-vue",
    priority: 0,
    privateOptions: {
      htmlRender: { serviceSecret },
      oauth: { relaySecret },
    },
    ...overrides,
  };
}
void describe("manifest secrets resolution", () => {
  const plain: ManifestModule = {
    name: "@fixture/plain",
    priority: 1,
  };

  void it("maps each variable of the closed table to its manifest path", () => {
    assert.deepEqual(MANIFEST_SECRET_ENV, {
      DMS_HTML_RENDER_SECRET: ["htmlRender", "serviceSecret"],
      DMS_OAUTH_RELAY_SECRET: ["oauth", "relaySecret"],
    });
  });

  void it("reads both secrets the backend publishes in the manifest", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([plain, dmsModule(MANIFEST_SECRET)]),
      {},
    );
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: MANIFEST_SECRET,
      DMS_OAUTH_RELAY_SECRET: RELAY_SECRET,
    });
    assert.deepEqual(resolved.sources, {
      DMS_HTML_RENDER_SECRET: "manifest",
      DMS_OAUTH_RELAY_SECRET: "manifest",
    });
    assert.deepEqual(resolved.conflicts, []);
  });

  void it("ignores values that are not a non-empty string", () => {
    for (const value of [null, "", 42, { nested: "x" }]) {
      const resolved = resolveManifestSecrets(
        collectManifestSecrets([dmsModule(value, value)]),
        {},
      );
      assert.deepEqual(resolved.env, {});
      assert.deepEqual(resolved.sources, {
        DMS_HTML_RENDER_SECRET: "not set",
        DMS_OAUTH_RELAY_SECRET: "not set",
      });
    }
    assert.deepEqual(
      resolveManifestSecrets(collectManifestSecrets([]), {}).env,
      {},
    );
  });

  void it("lets the manifest win, a variable filling in a secret it leaves out", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([dmsModule(MANIFEST_SECRET, null)]),
      {
        DMS_HTML_RENDER_SECRET: "deployment-secret",
        DMS_OAUTH_RELAY_SECRET: "deployment-relay",
      },
    );
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: MANIFEST_SECRET,
      DMS_OAUTH_RELAY_SECRET: "deployment-relay",
    });
    assert.deepEqual(resolved.sources, {
      DMS_HTML_RENDER_SECRET: "manifest",
      DMS_OAUTH_RELAY_SECRET: "env",
    });
    assert.equal(
      resolveManifestSecrets(collectManifestSecrets([]), {
        DMS_OAUTH_RELAY_SECRET: "deployment-relay",
      }).env.DMS_OAUTH_RELAY_SECRET,
      "deployment-relay",
    );
  });

  void it("takes the first value in manifest priority order and reports a conflict", () => {
    const low = dmsModule("low-render", "low-relay", {
      name: "@fixture/low",
      priority: 1,
    });
    const high = dmsModule("high-render", null, {
      name: "@fixture/high",
      priority: 5,
    });
    const same = dmsModule("high-render", "", {
      name: "@fixture/same",
      priority: 3,
    });
    const secrets = collectManifestSecrets([low, same, high]);
    const resolved = resolveManifestSecrets(secrets, {});
    assert.deepEqual(resolved.env, {
      DMS_HTML_RENDER_SECRET: "high-render",
      DMS_OAUTH_RELAY_SECRET: "low-relay",
    });
    assert.deepEqual(resolved.conflicts, [
      {
        name: "DMS_HTML_RENDER_SECRET",
        used: "@fixture/high",
        ignored: ["@fixture/low"],
      },
    ]);
    const warnings = formatSecretConflicts(resolved.conflicts);
    assert.deepEqual(warnings, [
      "DMS_HTML_RENDER_SECRET: @fixture/low publishes a different value than @fixture/high; using @fixture/high's",
    ]);
    for (const value of ["high-render", "low-render", "low-relay"])
      assert.ok(!warnings.join("\n").includes(value));

    assert.deepEqual(
      resolveManifestSecrets(secrets, { DMS_HTML_RENDER_SECRET: "set" })
        .conflicts,
      resolved.conflicts,
    );
  });

  void it("keeps manifest order between modules of equal priority", () => {
    const first = dmsModule("first", null, { name: "@fixture/first" });
    const second = dmsModule("second", null, { name: "@fixture/second" });
    assert.equal(
      resolveManifestSecrets(collectManifestSecrets([first, second]), {}).env
        .DMS_HTML_RENDER_SECRET,
      "first",
    );
  });
});

void describe("the server secrets report", () => {
  void it("groups the secrets the server receives by where they come from", () => {
    assert.equal(
      describeSecretSources({
        DMS_HTML_RENDER_SECRET: "env",
        DMS_OAUTH_RELAY_SECRET: "manifest",
      }),
      "DMS_HTML_RENDER_SECRET from the environment; DMS_OAUTH_RELAY_SECRET from the manifest",
    );
    assert.equal(
      describeSecretSources(
        {
          DMS_HTML_RENDER_SECRET: "manifest",
          DMS_OAUTH_RELAY_SECRET: "manifest",
        },
        "the build-time manifest",
      ),
      "DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the build-time manifest",
    );
    assert.equal(
      describeSecretSources({
        DMS_HTML_RENDER_SECRET: "not set",
        DMS_OAUTH_RELAY_SECRET: "not set",
      }),
      undefined,
    );
  });

  void it("warns about each missing secret with what it costs, then how to set them", () => {
    const memory = memoryUi();
    reportManifestSecrets(
      resolveManifestSecrets(collectManifestSecrets([]), {}),
      (count) => `Set the ${count}`,
      memory.ui,
    );
    assert.equal(memory.stdout(), "");
    assert.equal(
      memory.stderr(),
      "▲ DMS_HTML_RENDER_SECRET is not set: e-mail renders will be refused\n" +
        "▲ DMS_OAUTH_RELAY_SECRET is not set: OAuth sign-in will be refused by the backend\n" +
        "  → Set the 2\n",
    );
  });

  void it("says nothing about the secrets the server receives", () => {
    const memory = memoryUi();
    reportManifestSecrets(
      resolveManifestSecrets(
        collectManifestSecrets([dmsModule(MANIFEST_SECRET)]),
        {},
      ),
      () => "unused",
      memory.ui,
    );
    assert.equal(memory.stderr(), "");
  });

  void it("never prints a secret value", () => {
    const resolved = resolveManifestSecrets(
      collectManifestSecrets([
        dmsModule(MANIFEST_SECRET, null),
        dmsModule("other-render", null, {
          name: "@fixture/other",
          priority: -1,
        }),
      ]),
      { DMS_OAUTH_RELAY_SECRET: "deployment-relay" },
    );
    const memory = memoryUi();
    reportManifestSecrets(resolved, () => "unused", memory.ui);
    const output = `${memory.stderr()}${describeSecretSources(resolved.sources)}`;
    assert.match(output, /@fixture\/other/);
    assert.match(output, /DMS_OAUTH_RELAY_SECRET from the environment/);
    for (const value of [
      MANIFEST_SECRET,
      "other-render",
      RELAY_SECRET,
      "deployment-relay",
    ])
      assert.ok(!output.includes(value), `leaked ${value}`);
  });
});
