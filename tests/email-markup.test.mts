import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import { createSSRApp, Fragment, h } from "vue";
import { stripSsrMarkers } from "../templates/vue/email-markup.ts";

const OUTLOOK_COMMENT = "<!--[if mso]><table><tr><td><![endif]-->";

describe("stripSsrMarkers", () => {
  it("removes the hydration markers of a server-rendered email", async () => {
    const app = createSSRApp({
      render: () =>
        h("div", [
          null,
          h(
            Fragment,
            ["a", "b"].map((item) => h("p", item)),
          ),
        ]),
    });
    const rendered = await renderToString(app);
    assert.match(rendered, /<!--\[-->/);
    assert.match(rendered, /<!---->/);
    assert.equal(stripSsrMarkers(rendered), "<div><p>a</p><p>b</p></div>");
  });

  it("removes v-if and teleport markers", () => {
    assert.equal(
      stripSsrMarkers(
        "<!--v-if--><!--teleport start--><!--teleport end--><!--teleport anchor--><p>x</p>",
      ),
      "<p>x</p>",
    );
  });

  it("keeps Outlook conditional comments and other comments", () => {
    const html = `${OUTLOOK_COMMENT}<!-- note --><p>&lt;!--[--&gt;</p>`;
    assert.equal(stripSsrMarkers(html), html);
  });
});
