import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uiLazyIcons } from "../templates/vue/ui-lazy-icons.mjs";

const ICONS_PLUGIN =
  "/w/node_modules/.pnpm/@nuxt+ui@4.10.0/node_modules/@nuxt/ui/dist/runtime/vue/plugins/icons.js";

const NUXT_UI_4_10 = `import { addIcon } from "@iconify/vue";
import { init } from "virtual:nuxt-ui-icons";
export default {
  install() {
    init((name, data) => addIcon(name, data));
  }
};
`;

function transform(
  code: string,
  { consumer = "client", id = ICONS_PLUGIN } = {},
) {
  const plugin = uiLazyIcons((file: string) =>
    file.includes("/node_modules/@nuxt/ui/"),
  );
  const context = {
    environment: { config: { consumer } },
    error(message: string): never {
      throw new Error(message);
    },
  };
  return plugin.transform.call(context, code, id);
}

describe("Nuxt UI's icons plugin", () => {
  it("installs no icon bundle in the client build, which loads it when a page needs it", () => {
    const result = transform(NUXT_UI_4_10);
    assert.ok(result);
    assert.doesNotMatch(result.code, /virtual:nuxt-ui-icons/);
  });

  it("is left as it is in the server build, whose render draws icons from it", () => {
    assert.equal(transform(NUXT_UI_4_10, { consumer: "server" }), null);
  });

  it("leaves another module of Nuxt UI alone", () => {
    assert.equal(
      transform(NUXT_UI_4_10, {
        id: "/w/node_modules/@nuxt/ui/dist/runtime/vue/plugins/head.js",
      }),
      null,
    );
  });

  it("fails the build when Nuxt UI installs the bundle another way", () => {
    assert.throws(
      () => transform("export default { install() {} };"),
      /ui-lazy-icons\.mjs/,
    );
  });
});
