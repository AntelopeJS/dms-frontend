import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToString } from "@vue/server-renderer";
import {
  type App,
  type Component,
  computed,
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  nextTick,
  ref,
} from "vue";
import { uiKbd } from "../templates/vue/ui-kbd.mjs";
import * as runtimeModule from "../templates/vue/frontend-module.ts";

const USE_KBD =
  "/w/node_modules/.pnpm/@nuxt+ui@4.10.0/node_modules/@nuxt/ui/dist/runtime/composables/useKbd.js";

/** Nuxt UI 4.10's useKbd.js, verbatim but for the key map, shortened. */
const NUXT_UI_4_10 = `import { reactive, computed, onMounted } from "vue";
import { createSharedComposable } from "@vueuse/core";
export const kbdKeysMap = {
  meta: "",
  ctrl: "",
  alt: "",
  command: "\\u2318",
  shift: "\\u21E7"
};
const _useKbd = () => {
  const macOS = computed(() => import.meta.client && navigator && navigator.userAgent && navigator.userAgent.match(/Macintosh;/));
  const kbdKeysSpecificMap = reactive({
    meta: " ",
    alt: " ",
    ctrl: " "
  });
  onMounted(() => {
    kbdKeysSpecificMap.meta = macOS.value ? kbdKeysMap.command : "Ctrl";
  });
  function getKbdKey(value) {
    return kbdKeysSpecificMap[value] ?? kbdKeysMap[value] ?? value;
  }
  return {
    macOS,
    getKbdKey
  };
};
export const useKbd = /* @__PURE__ */ createSharedComposable(_useKbd);
`;

function transform(code: string, id = USE_KBD) {
  const plugin = uiKbd((file: string) =>
    file.includes("/node_modules/@nuxt/ui/"),
  );
  const context = {
    error(message: string): never {
      throw new Error(message);
    },
  };
  return plugin.transform.call(context, code, id);
}

describe("Nuxt UI's useKbd", () => {
  it("is routed to the DMS runtime, the shared one kept for the platform", () => {
    const code = transform(NUXT_UI_4_10)?.code ?? "";
    assert.match(
      code,
      /import \{ useDmsKbd \} from "#dms\/frontend-module";\nconst useSharedKbd = \/\* @__PURE__ \*\/ createSharedComposable\(_useKbd\);\nexport const useKbd = \(\) => useDmsKbd\(useSharedKbd, kbdKeysMap\);/,
    );
    assert.doesNotMatch(code, /export const useKbd = \/\* @__PURE__ \*\//);
  });

  it("fails the build in a form the rewrite does not know", () => {
    assert.throws(
      () =>
        transform(
          NUXT_UI_4_10.replace(
            "createSharedComposable(_useKbd)",
            "createGlobalState(_useKbd)",
          ),
        ),
      /does not rewrite/,
    );
  });

  it("leaves other files alone", () => {
    assert.equal(transform(NUXT_UI_4_10, "/w/src/useKbd.js"), null);
    assert.equal(
      transform(
        "export const x = 1;\n",
        "/w/node_modules/@nuxt/ui/dist/runtime/composables/useToast.js",
      ),
      null,
    );
  });
});

const { provideDmsKbdPlatform, useDmsKbd } = runtimeModule;

const KEYS = { command: "⌘", shift: "⇧", meta: "", ctrl: "", alt: "" };

/** Nuxt UI's shared part, as `useDmsKbd` receives it. */
function sharedKbd(isMac: boolean) {
  return () => ({
    macOS: computed(() => isMac),
    getKbdKey: (value?: string) => value,
  });
}

/** A hint as Nuxt UI's `Kbd.vue` prints it. */
function hint(isMac: boolean, values = ["meta", "ctrl", "alt", "shift", "k"]) {
  return defineComponent({
    setup() {
      const { getKbdKey } = useDmsKbd(sharedKbd(isMac), KEYS);
      return () => h("kbd", values.map((value) => getKbdKey(value)).join("|"));
    },
  });
}

/** Mounts components without a DOM, the way the browser runtime runs them. */
function mountFresh(root: Component, setup?: (app: App) => void) {
  interface Node {
    text: string;
    parent: Node | null;
    children: Node[];
  }
  const node = (text = ""): Node => ({ text, parent: null, children: [] });
  const renderer = createRenderer<Node, Node>({
    createElement: () => node(),
    createText: (text) => node(text),
    createComment: () => node(),
    setText(target, text) {
      target.text = text;
    },
    setElementText(target, text) {
      target.text = text;
    },
    patchProp() {},
    parentNode: (child) => child.parent,
    nextSibling: () => null,
    insert(child, parent) {
      child.parent = parent;
      parent.children.push(child);
    },
    remove() {},
  });
  const container = node();
  const app = renderer.createApp(root);
  setup?.(app);
  app.mount(container);
  const text = (target: Node): string =>
    target.text + target.children.map(text).join("");
  return { text: () => text(container), app };
}

const realWindow = globalThis.window;
afterEach(() => {
  globalThis.window = realWindow;
});

describe("Key hints in a server render", () => {
  it("prints the application's platform from the server on", async () => {
    for (const [platform, printed] of [
      ["mac", "⌘|⌃|⌥|⇧|k"],
      ["other", "Ctrl|Ctrl|Alt|⇧|k"],
    ] as const) {
      const app = createSSRApp(hint(false));
      provideDmsKbdPlatform(app, () => ref(platform));
      assert.equal(await renderToString(app), `<kbd>${printed}</kbd>`);
    }
  });

  it("calls the platform source in the setup of each hint", async () => {
    let calls = 0;
    const app = createSSRApp({
      render: () => h("div", [h(hint(false)), h(hint(false))]),
    });
    provideDmsKbdPlatform(app, () => {
      calls += 1;
      return ref("mac");
    });
    await renderToString(app);
    assert.equal(calls, 2);
  });

  it("prints Nuxt UI's blank without a platform, as before", async () => {
    assert.equal(
      await renderToString(createSSRApp(hint(true))),
      "<kbd> | | |⇧|k</kbd>",
    );
  });
});

describe("Key hints mounted in the browser", () => {
  it("print the browser's platform at once without a platform source", () => {
    Reflect.set(globalThis, "window", {});
    const mac = mountFresh(hint(true));
    assert.equal(mac.text(), "⌘|⌃|⌥|⇧|k");
    const pc = mountFresh(hint(false));
    assert.equal(pc.text(), "Ctrl|Ctrl|Alt|⇧|k");
  });

  it("follow the platform source when the application gives one", async () => {
    Reflect.set(globalThis, "window", {});
    const platform = ref<"mac" | "other">("other");
    const mounted = mountFresh(hint(true), (app) =>
      provideDmsKbdPlatform(app, () => platform),
    );
    assert.equal(mounted.text(), "Ctrl|Ctrl|Alt|⇧|k");
    platform.value = "mac";
    await nextTick();
    assert.equal(mounted.text(), "⌘|⌃|⌥|⇧|k");
  });
});
