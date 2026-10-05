import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { _api, Icon, iconLoaded } from "@iconify/vue";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import {
  addDmsIcons,
  drawLoadedIconsAtOnce,
  registerDmsIconCollections,
  serializeDmsIcons,
  trackDmsIcons,
} from "../templates/vue/icon-hydration.ts";

const CHECK_PATH = '<path d="M1 1h2"/>';
const COLLECTION = {
  prefix: "demo",
  width: 24,
  height: 24,
  icons: { check: { body: CHECK_PATH } },
};

function page(...icons: string[]) {
  return createSSRApp({
    render: () => icons.map((icon) => h(Icon, { icon })),
  });
}

describe("Icons in a server render", () => {
  const queries: unknown[] = [];

  before(() => {
    _api.setFetch(async (...query: unknown[]) => {
      queries.push(query);
      throw new Error("no Iconify API in a server render");
    });
    drawLoadedIconsAtOnce();
    registerDmsIconCollections([COLLECTION]);
  });

  it("draws an icon of a registered collection, a backend-named one included", async () => {
    assert.match(await renderToString(page("demo-check")), /M1 1h2/);
    assert.match(await renderToString(page("demo:check")), /M1 1h2/);
  });

  it("leaves an icon without data empty, without querying an API", async () => {
    const html = await renderToString(page("demo-missing", "other-icon"));
    assert.doesNotMatch(html, /<path/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(queries, []);
  });

  it("hands the browser the data of each icon it drew", async () => {
    const app = page("demo-check", "demo-missing");
    const drawn = trackDmsIcons(app);
    await renderToString(app);

    assert.deepEqual([...drawn], ["demo-check", "demo-missing"]);
    const icons = serializeDmsIcons(drawn);
    assert.deepEqual(Object.keys(icons), ["demo-check"]);
    assert.equal(icons["demo-check"].body, CHECK_PATH);
  });

  it("lets the browser draw a handed-over icon in its first render", async () => {
    assert.equal(iconLoaded("handed-over"), false);
    addDmsIcons({ "handed-over": { body: CHECK_PATH } });
    assert.equal(iconLoaded("handed-over"), true);
    assert.match(await renderToString(page("handed-over")), /M1 1h2/);
  });
});
