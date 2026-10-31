import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import vue from "@vitejs/plugin-vue";
import { createServer } from "vite";
import { developmentStyleTags } from "../templates/vue/server/dev-styles.mjs";
import { orderHeadForFirstPaint } from "../templates/vue/head-order.mjs";

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

describe("development stylesheets in the served document", () => {
  it("links every stylesheet the server-side render reached", async () => {
    const root = mkdtempSync(join(tmpdir(), "dms-dev-styles-"));
    writeFixture(root, "package.json", '{"type":"module"}');
    writeFixture(root, "module.css", ".dms-example { color: rebeccapurple; }");
    writeFixture(
      root,
      "ssr-entry.js",
      'import "./module.css";\nexport const ready = true;',
    );
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true },
      appType: "custom",
    });
    try {
      await server.ssrLoadModule("/ssr-entry.js");
      const tags = await developmentStyleTags(server);
      assert.match(
        tags,
        /<link rel="stylesheet" data-dms-dev-style="[^"]*module\.css" href="\/module\.css\?direct">/,
        "a stylesheet the render reached must be in the document, not injected later by JavaScript",
      );
      assert.match(
        tags,
        /href="\/dms-main\.css\?direct"/,
        "the generated entry stylesheet is client-only, so it is named rather than discovered",
      );
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("inlines a component's own styles, which are not served as CSS", async () => {
    const styleUrl = "/Widget.vue?vue&type=style&index=0&scoped=abc&lang.css";
    const devServer = {
      environments: {
        ssr: {
          moduleGraph: {
            urlToModuleMap: new Map([
              [styleUrl, { id: `/workspace${styleUrl}` }],
              ["/plain.css", { id: "/workspace/plain.css" }],
              ["/ignored.ts", { id: "/workspace/ignored.ts" }],
            ]),
          },
        },
      },
      transformRequest: async () => ({ code: ".widget { display: none; }" }),
    };
    const tags = await developmentStyleTags(devServer);
    assert.match(
      tags,
      /<style data-dms-dev-style="\/workspace\/Widget\.vue[^"]*">\.widget \{ display: none; \}<\/style>/,
    );
    assert.doesNotMatch(
      tags,
      /<link[^>]*Widget\.vue/,
      "Vite answers a component style block with a JavaScript content type, which a browser refuses as a stylesheet",
    );
    assert.match(
      tags,
      /<link rel="stylesheet"[^>]*href="\/plain\.css\?direct">/,
    );
    assert.doesNotMatch(tags, /ignored\.ts/);
  });

  it("serves a component's style block compiled, with its package imports resolved", async () => {
    const root = mkdtempSync(
      join(process.cwd(), "node_modules", ".dms-dev-styles-"),
    );
    writeFixture(root, "package.json", '{"type":"module"}');
    writeFixture(
      root,
      "node_modules/fixture-pkg/package.json",
      '{"name":"fixture-pkg","version":"1.0.0"}',
    );
    writeFixture(
      root,
      "node_modules/fixture-pkg/dist/style.css",
      ".fixture-pkg-rule { color: rebeccapurple; }",
    );
    writeFixture(
      root,
      "Widget.vue",
      [
        "<script>export default {};</script>",
        "<style>",
        '@import "fixture-pkg/dist/style.css";',
        ".own-rule { display: block; }",
        "</style>",
        "",
      ].join("\n"),
    );
    writeFixture(
      root,
      "ssr-entry.js",
      'import Widget from "./Widget.vue";\nexport default Widget;',
    );
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      server: { middlewareMode: true },
      appType: "custom",
      plugins: [vue()],
    });
    try {
      await server.ssrLoadModule("/ssr-entry.js");
      const tags = await developmentStyleTags(server);
      assert.match(tags, /\.own-rule/);
      assert.match(
        tags,
        /\.fixture-pkg-rule/,
        "the package stylesheet must be inlined where Vite compiles the block",
      );
      assert.doesNotMatch(
        tags,
        /@import/,
        "a bare specifier left in the document is resolved by the browser against the page URL, which answers 404",
      );
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a style block that could close its own tag", async () => {
    const devServer = {
      environments: {
        ssr: {
          moduleGraph: {
            urlToModuleMap: new Map([
              [
                "/Evil.vue?vue&type=style&lang.css",
                { id: "/workspace/Evil.vue" },
              ],
            ]),
          },
        },
      },
      transformRequest: async () => ({
        code: '.a::after { content: "</style>"; }',
      }),
    };
    const tags = await developmentStyleTags(devServer);
    assert.doesNotMatch(tags, /<style/);
  });
});

describe("first paint in the built document", () => {
  const built = [
    "<head>",
    "    <title>Antelope DMS</title>",
    '    <script type="module" crossorigin src="/assets/index-a.js"></script>',
    '    <link rel="stylesheet" crossorigin href="/assets/index-b.css">',
    "  </head>",
  ].join("\n");

  it("puts the stylesheet ahead of the entry script and restores its priority", () => {
    const ordered = orderHeadForFirstPaint(built);
    assert.match(ordered, /<script[^>]*fetchpriority="low"/);
    assert.ok(
      ordered.indexOf('rel="stylesheet"') < ordered.indexOf("<script type") ||
        ordered.indexOf('rel="stylesheet"') <
          ordered.indexOf("<script fetchpriority"),
      "the render-blocking stylesheet must be discovered before the hydration bundle",
    );
    assert.equal(ordered.match(/rel="stylesheet"/g)?.length, 1);
  });

  it("leaves an already ordered document alone", () => {
    const once = orderHeadForFirstPaint(built);
    assert.equal(orderHeadForFirstPaint(once), once);
  });
});
