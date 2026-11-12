import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  frontendRegistryOf,
  iconCollectionOf,
  serverOptionsOf,
  viteManifestOf,
} from "../templates/vue/server/generated-files.mjs";

void describe("The module registry the build writes", () => {
  void it("is the list of modules with their ids and options", () => {
    const registry = {
      modules: [
        { id: "a", options: { homepage: "/start" } },
        { id: "b", name: "kept", version: "1.0.0" },
      ],
    };
    assert.deepEqual(frontendRegistryOf(registry), registry);
    assert.deepEqual(frontendRegistryOf({ modules: [] }), { modules: [] });
  });

  void it("is refused when it is not a list of modules that have an id", () => {
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

void describe("The server options the build writes", () => {
  void it("are the private options by module id and the variables by secret path", () => {
    const options = {
      modules: { a: { secret: "", nested: { key: "" } } },
      environment: { DMS_HTML_RENDER_SECRET: ["secret"] },
    };
    assert.deepEqual(serverOptionsOf(options), options);
  });

  void it("read an absent part as empty", () => {
    assert.deepEqual(serverOptionsOf({}), { modules: {}, environment: {} });
    assert.deepEqual(serverOptionsOf({ modules: { a: {} } }), {
      modules: { a: {} },
      environment: {},
    });
  });

  void it("are refused when a part has the wrong shape", () => {
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

void describe("The client manifest Vite writes", () => {
  void it("is an object of chunks, whose members are kept as they are", () => {
    const manifest = {
      "index.html": {
        file: "assets/index.js",
        src: "index.html",
        isEntry: true,
        css: ["assets/index.css"],
        imports: ["_vendor.js"],
      },
      "_vendor.js": { file: "assets/vendor.js" },
    };
    assert.deepEqual(viteManifestOf(manifest), manifest);
    assert.deepEqual(viteManifestOf({}), {});
  });

  void it("is refused when it is not an object of chunks that name their file", () => {
    for (const content of [
      null,
      "abc",
      [],
      { a: null },
      { a: {} },
      { a: { file: 5 } },
      { a: { file: "x.js", css: "x.css" } },
      { a: { file: "x.js", imports: [5] } },
      { a: { file: "x.js", isEntry: "yes" } },
    ])
      assert.throws(
        () => viteManifestOf(content),
        /the client manifest is not an object of Vite chunks/,
        JSON.stringify(content),
      );
  });
});

void describe("The icon collection of an Iconify package", () => {
  void it("is kept as it is when its icons and aliases have the members Iconify gives them", () => {
    const collection = {
      prefix: "lucide",
      lastModified: 1700000000,
      width: 24,
      height: 24,
      icons: { home: { body: "<path/>" }, flip: { body: "<g/>", hFlip: true } },
      aliases: { house: { parent: "home", rotate: 1 } },
    };
    assert.deepEqual(iconCollectionOf(collection), collection);
    assert.deepEqual(iconCollectionOf({ prefix: "x", icons: {} }), {
      prefix: "x",
      icons: {},
    });
  });

  void it("is refused when it is not an Iconify icon set", () => {
    for (const content of [
      null,
      "abc",
      [],
      {},
      { prefix: 5, icons: {} },
      { prefix: "x" },
      { prefix: "x", icons: { a: {} } },
      { prefix: "x", icons: { a: { body: 5 } } },
      { prefix: "x", icons: {}, aliases: { a: { body: "<g/>" } } },
      { prefix: "x", icons: { a: { body: "<g/>", width: "24" } } },
      { prefix: "x", icons: {}, lastModified: "now" },
    ])
      assert.throws(
        () => iconCollectionOf(content),
        /the icon collection is not an Iconify icon set/,
        JSON.stringify(content),
      );
  });
});
