import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  frontendRegistryOf,
  serverOptionsOf,
} from "../templates/vue/server/generated-files.mjs";

describe("The module registry the build writes", () => {
  it("is the list of modules with their ids and options", () => {
    const registry = {
      modules: [
        { id: "a", options: { homepage: "/start" } },
        { id: "b", name: "kept", version: "1.0.0" },
      ],
    };
    assert.deepEqual(frontendRegistryOf(registry), registry);
    assert.deepEqual(frontendRegistryOf({ modules: [] }), { modules: [] });
  });

  it("is refused when it is not a list of modules that have an id", () => {
    for (const content of [
      null,
      "abc",
      5,
      [],
      {},
      { modules: "abc" },
      { modules: {} },
      { modules: [null] },
      { modules: [{}] },
      { modules: [{ id: 5 }] },
      { modules: [{ id: "a" }, "b"] },
    ])
      assert.throws(
        () => frontendRegistryOf(content),
        /generated-frontend-modules\.json is not a list of modules/,
        JSON.stringify(content),
      );
  });
});

describe("The server options the build writes", () => {
  it("are the private options by module id and the variables by secret path", () => {
    const options = {
      modules: { a: { secret: "", nested: { key: "" } } },
      environment: { DMS_HTML_RENDER_SECRET: ["secret"] },
    };
    assert.deepEqual(serverOptionsOf(options), options);
  });

  it("read an absent part as empty", () => {
    assert.deepEqual(serverOptionsOf({}), { modules: {}, environment: {} });
    assert.deepEqual(serverOptionsOf({ modules: { a: {} } }), {
      modules: { a: {} },
      environment: {},
    });
  });

  it("are refused when a part has the wrong shape", () => {
    for (const content of [
      null,
      "abc",
      5,
      [],
      { modules: "abc" },
      { modules: [] },
      { modules: { a: "x" } },
      { modules: { a: [] } },
      { environment: "abc" },
      { environment: { NAME: "secret" } },
      { environment: { NAME: [5] } },
    ])
      assert.throws(
        () => serverOptionsOf(content),
        /generated-server-options\.json is not what the build writes/,
        JSON.stringify(content),
      );
  });
});
