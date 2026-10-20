// A page whose setup throws (dms's `/auth/recover` without its token) shows the
// error page, but Vue still renders the page itself first, against the setup
// state that never came. A development server compiles a single-file
// component's template apart from its setup, so the template reads the missing
// bindings, and Vue warns about each component it uses ("Invalid vnode type
// when creating vnode: undefined", then "Component <Anonymous> is missing
// template or render function" for the comment it renders instead). The pages
// here are compiled the way @vitejs/plugin-vue compiles them for that server.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { after, before, describe, it, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import { renderToString } from "@vue/server-renderer";
import {
  type Component,
  createSSRApp,
  defineComponent,
  h,
  Suspense,
} from "vue";
import { compileScript, compileTemplate, parse } from "vue/compiler-sfc";
import { createI18n } from "vue-i18n";
import {
  createDmsFrontendRuntime,
  installDmsPlugins,
  provideDmsFrontendRuntime,
  setupFrontendModules,
} from "../templates/vue/frontend-module.ts";

// Inside the repository, so the compiled modules resolve its `vue`.
const directory = mkdtempSync(resolve(".failed-setup-"));
after(() => rmSync(directory, { recursive: true, force: true }));

/** A single-file component as the development SSR server loads it. */
async function devComponent(name: string, source: string): Promise<Component> {
  const filename = join(directory, `${name}.vue`);
  const { descriptor } = parse(source, { filename });
  const script = compileScript(descriptor, {
    id: name,
    inlineTemplate: false,
    genDefaultAs: "_sfc_main",
  });
  const template = compileTemplate({
    source: descriptor.template!.content,
    filename,
    id: name,
    ssr: true,
    ssrCssVars: [],
    compilerOptions: { bindingMetadata: script.bindings },
  });
  const file = join(directory, `${name}.mjs`);
  writeFileSync(
    file,
    `${script.content}\n${template.code.replace("export function ssrRender", "function ssrRender")}\n` +
      `_sfc_main.ssrRender = ssrRender;\n_sfc_main.__file = ${JSON.stringify(filename)};\nexport default _sfc_main;\n`,
  );
  return (await import(pathToFileURL(file).href)).default;
}

const card = `<script setup>const tone = "neutral";</script>
<template><section :class="tone"><slot /></section></template>`;

/** dms's recover page: the setup refuses a link without its parameters. */
const page = (wait: string) => `<script setup>
import StageCard from "./StageCard.mjs";
const props = defineProps({ token: String });
${wait}
if (!props.token) throw Object.assign(new Error("Missing required authentication parameters"), { statusCode: 400 });
const isLoading = false;
</script>
<template><StageCard><p>{{ isLoading }}</p></StageCard></template>`;

/** Warns from its own, healthy, render: it uses a component without a template. */
const Untidy = defineComponent({
  name: "Untidy",
  setup: () => () => h(defineComponent({ name: "Blank" })),
});

let SyncPage: Component;
let AsyncPage: Component;

before(async () => {
  await setupFrontendModules([]);
  await devComponent("StageCard", card);
  SyncPage = await devComponent("SyncPage", page(""));
  AsyncPage = await devComponent("AsyncPage", page("await Promise.resolve();"));
});

async function render(context: TestContext, ...children: Array<() => unknown>) {
  const warnings: string[] = [];
  context.mock.method(console, "warn", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });
  const app = createSSRApp({
    render: () =>
      // As the renderer shows a page: in a `<Suspense>`, which an async
      // setup needs.
      h(Suspense, null, {
        default: () =>
          h(
            "main",
            children.map((child) => child()),
          ),
      }),
  });
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  provideDmsFrontendRuntime(app, runtime);
  const i18n = createI18n({ legacy: false, locale: "en", messages: {} });
  await installDmsPlugins(app, i18n.global, runtime, async () => ({}), ["en"]);
  await renderToString(app);
  context.mock.restoreAll();
  return {
    warnings,
    error: runtime.currentError.value as
      | (Error & { statusCode?: number })
      | null,
  };
}

describe("a page whose setup fails", () => {
  for (const [kind, component] of [
    ["sync", () => SyncPage],
    ["async", () => AsyncPage],
  ] as const) {
    it(`fails the page without warnings from its unrendered template (${kind} setup)`, async (context) => {
      const { warnings, error } = await render(context, () => h(component()));
      assert.equal(error?.statusCode, 400);
      assert.deepEqual(warnings, []);
    });
  }

  it("still renders a page given its parameters", async (context) => {
    const warnings: string[] = [];
    context.mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    const app = createSSRApp({ render: () => h(SyncPage, { token: "t" }) });
    const runtime = createDmsFrontendRuntime(undefined, {}, true);
    provideDmsFrontendRuntime(app, runtime);
    const i18n = createI18n({ legacy: false, locale: "en", messages: {} });
    await installDmsPlugins(app, i18n.global, runtime, async () => ({}), [
      "en",
    ]);
    assert.equal(
      await renderToString(app),
      '<section class="neutral"><!--[--><p>false</p><!--]--></section>',
    );
    assert.equal(runtime.currentError.value, null);
    assert.deepEqual(warnings, []);
  });

  it("keeps the warnings of the components that did not fail", async (context) => {
    const { warnings, error } = await render(
      context,
      () => h(SyncPage),
      () => h(Untidy),
    );
    assert.equal(error?.statusCode, 400);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      /^\[Vue warn\]: Component Blank is missing template or render function\.\nat <Blank>\nat <Untidy>/,
    );
  });

  it("leaves Vue's own warnings alone while nothing failed", async (context) => {
    const { warnings, error } = await render(context, () => h(Untidy));
    assert.equal(error, null);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0]!,
      /Component Blank is missing template or render function/,
    );
  });
});
