import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { _api, Icon, iconLoaded } from "@iconify/vue";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, h } from "vue";
import {
  addDmsIcons,
  collectDmsIconSymbols,
  dmsIconSprite,
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

  it("draws each icon once in the page's sprite, every occurrence using it", async () => {
    const app = createSSRApp({
      render: () => [
        h(Icon, { icon: "demo-check" }),
        h(Icon, { icon: "demo-check" }),
        h(Icon, { icon: "demo-check", hFlip: true }),
      ],
    });
    const symbols = collectDmsIconSymbols(app);
    const html = await renderToString(app);
    assert.doesNotMatch(html, /M1 1h2/);
    const uses = [
      ...html.matchAll(/<use href="#(dms-icon-[a-z0-9]+)"><\/use>/g),
    ];
    assert.equal(uses.length, 3);
    assert.equal(uses[0][1], uses[1][1]);
    assert.notEqual(uses[0][1], uses[2][1]);
    assert.match(html, /viewBox="0 0 24 24"/);
    const sprite = dmsIconSprite(symbols);
    assert.equal(sprite.match(/<symbol /g)?.length, 2);
    assert.match(
      sprite,
      new RegExp(
        `<symbol id="${uses[0][1]}" viewBox="0 0 24 24"><path d="M1 1h2"/></symbol>`,
      ),
    );
    assert.match(
      sprite,
      /^<svg id="dms-icon-sprite" aria-hidden="true" style="display:none">/,
    );
    assert.equal(dmsIconSprite(new Map()), "");
  });
});
