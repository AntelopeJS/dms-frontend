import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { withFaviconPlaceholder } from "../templates/vue/server/favicon.mjs";

const PLACEHOLDER = '<link rel="icon" href="data:," />';

describe("the favicon placeholder", () => {
  it("is left out of the template, which every page shares", () => {
    const template = readFileSync(
      new URL("../templates/vue/index.html", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(template, /rel="icon"/);
  });

  it("goes in front of a head that declares no icon", () => {
    // What a render without `useHead` icons, or the client-rendering fallback
    // of a failed one, hands the template.
    for (const headTags of [
      "",
      "<title>Orders</title>",
      '<link rel="apple-touch-icon" href="/touch.png"><link rel="stylesheet" href="/icons.css">',
      '<meta name="description" content="rel=&quot;icon&quot;">',
    ])
      assert.equal(
        withFaviconPlaceholder(headTags),
        `${PLACEHOLDER}${headTags}`,
        headTags,
      );
  });

  it("stays out of a head that declares its own icon", () => {
    for (const headTags of [
      '<title>Orders</title><link rel="icon" href="/favicon.svg">',
      // The DMS declares one icon per color scheme.
      '<link rel="icon" href="/branding/icon-light.svg" media="(prefers-color-scheme: light)"><link rel="icon" href="/branding/icon-dark.svg" media="(prefers-color-scheme: dark)">',
      "<link href='/favicon.ico' rel='shortcut icon'>",
      '<LINK REL="ICON" HREF="/favicon.png">',
    ])
      assert.equal(withFaviconPlaceholder(headTags), headTags, headTags);
  });
});
