import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { uiInertiaPage } from "../templates/vue/ui-inertia-page.mjs";

const NUXT_UI = "/w/node_modules/@nuxt/ui/dist/runtime/vue/stubs/inertia.js";

function transform(code: string, id = NUXT_UI) {
  const plugin = uiInertiaPage((file: string) =>
    file.includes("/node_modules/@nuxt/ui/"),
  );
  const context = {
    error(message: string): never {
      throw new Error(message);
    },
  };
  return plugin.transform.call(context, code, id);
}

describe("Nuxt UI's reads of Inertia's page", () => {
  it("read the DMS's per-request page instead", () => {
    const result = transform(
      'import { usePage } from "@inertiajs/vue3";\nexport const url = () => usePage().url;\n',
    );
    assert.equal(
      result?.code,
      'import { useDmsInertiaPage as usePage } from "#dms/frontend-module";\nexport const url = () => usePage().url;\n',
    );
  });

  it("fail the build in a form the rewrite does not know", () => {
    for (const code of [
      'import { router, usePage } from "@inertiajs/vue3";',
      'import { usePage as page } from "@inertiajs/vue3";',
      'import * as inertia from "@inertiajs/vue3";',
    ])
      assert.throws(() => transform(code), /does not rewrite/, code);
  });

  it("leave other files and other Inertia imports alone", () => {
    assert.equal(
      transform('import { usePage } from "@inertiajs/vue3";', "/w/src/a.ts"),
      null,
    );
    assert.equal(transform('import { router } from "@inertiajs/vue3";'), null);
  });
});
