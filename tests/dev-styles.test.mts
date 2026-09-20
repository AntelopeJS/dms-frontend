import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { runInNewContext } from "node:vm";
import { createServer, normalizePath } from "vite";
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
    const tags = await developmentStyleTags(devServer as never);
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
    const tags = await developmentStyleTags(devServer as never);
    assert.doesNotMatch(tags, /<style/);
  });

  it("hands each stylesheet over to Vite instead of leaving a duplicate", () => {
    const entry = readFileSync(join("templates", "vue", "main.ts"), "utf8");
    assert.match(entry, /data-dms-dev-style/);
    assert.match(entry, /MutationObserver/);
    assert.match(entry, /style\[data-vite-dev-id\]/);
    const styles = readFileSync(
      join("templates", "vue", "server", "dev-styles.mjs"),
      "utf8",
    );
    assert.doesNotMatch(
      styles,
      /"data-vite-dev-id"/,
      "reusing Vite's own attribute makes its client adopt the tag and skip updateStyle, stranding CSS edits",
    );
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

describe("dependency optimizer entries", () => {
  it("covers every materialized module rather than waiting for a page to need one", () => {
    const template = readFileSync(
      resolve("templates", "vue", "vite.config.ts"),
      "utf8",
    );
    const expression = template.match(
      /const optimizerEntries = ([\s\S]*?\n\][^;]*);/,
    );
    assert.ok(expression, "the template computes the optimizer's entry points");
    // `normalizePath` is the real one: it must stay the identity on POSIX.
    const entries = runInNewContext(`(${expression[1]})`, {
      __dirname: "/workspace",
      normalizePath,
      resolve: (...parts: string[]) => parts.join("/"),
      moduleRoots: ["/workspace/frontend-modules/core"],
      frontendSourceRoots: ["/workspace/frontend-modules/core/layers/ui"],
    }) as string[];
    assert.ok(
      entries.includes("/workspace/frontend-modules/core/dms.frontend.ts"),
      "each module's entry must be crawled at startup",
    );
    assert.ok(
      entries.some((entry) => entry.endsWith("layers/ui/app/**/*.vue")),
      "so must the sources it reaches, which carry the module's own dependencies",
    );
    assert.doesNotMatch(
      template,
      /entries: \[\]/,
      "an empty crawl makes a cold page re-run the optimizer mid-request, which answers 504 and forces a reload",
    );
  });
});
