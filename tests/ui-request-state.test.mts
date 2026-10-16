import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uiRequestState } from "../templates/vue/ui-request-state.mjs";

const STUB =
  "/w/node_modules/.pnpm/@nuxt+ui@4.10.0/node_modules/@nuxt/ui/dist/runtime/vue/stubs/base.js";

/** Nuxt UI 4.10's `useState`, verbatim, between two of its neighbours. */
const NUXT_UI_4_10 = `import { ref, onScopeDispose } from "vue";
export const useCookie = (_name, _options = {}) => {
  const value = ref(_options?.default?.() ?? null);
  return { value: value.value };
};
const state = {};
export const useState = (key, init) => {
  if (state[key]) {
    return state[key];
  }
  const value = ref(init());
  state[key] = value;
  return value;
};
const hooks = createHooks();
`;

function transform(code: string, id = STUB) {
  const plugin = uiRequestState((file: string) =>
    file.includes("/node_modules/@nuxt/ui/"),
  );
  const context = {
    error(message: string): never {
      throw new Error(message);
    },
  };
  return plugin.transform.call(context, code, id);
}

describe("Nuxt UI's useState", () => {
  it("keeps its state in the DMS's per-application state", () => {
    const code = transform(NUXT_UI_4_10)?.code ?? "";
    assert.match(
      code,
      /import \{ useDmsState \} from "#dms\/frontend-module";\nexport const useState = \(key, init\) => useDmsState\(`nuxt-ui:\$\{key\}`, init\);/,
    );
    assert.doesNotMatch(code, /const state = \{\}/);
    assert.match(code, /export const useCookie/, "the rest is kept");
    assert.match(code, /const hooks = createHooks\(\);/);
  });

  it("fails the build in a form the rewrite does not know", () => {
    assert.throws(
      () =>
        transform(
          "const store = new Map();\nexport const useState = (key, init) => store.get(key) ?? init();\n",
        ),
      /does not rewrite/,
    );
  });

  it("leaves other files alone", () => {
    assert.equal(transform(NUXT_UI_4_10, "/w/src/base.js"), null);
    assert.equal(
      transform(
        'import { useState } from "./base.js";\nexport const useLocale = () => useState("locale", () => "en");\n',
        "/w/node_modules/@nuxt/ui/dist/runtime/vue/stubs/inertia.js",
      ),
      null,
    );
  });

  it("fails the build when another Nuxt UI file defines useState", () => {
    assert.throws(
      () =>
        transform(
          NUXT_UI_4_10,
          "/w/node_modules/@nuxt/ui/dist/runtime/vue/stubs/state.js",
        ),
      /outside the stub the DMS rewrites/,
    );
  });
});
