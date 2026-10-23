// The workspace patches @vueuse/core (templates/vue/patches) so useColorMode
// stops re-applying a color mode `<html>` already carries: every re-apply
// injects a `*{transition:none}` sheet and reads getComputedStyle, a forced
// full style recalculation. The repository installs the same version with the
// same patch file (package.json `pnpm.patchedDependencies`), so this suite runs
// the code the workspace ships against a minimal document that counts those
// recalculations and sheet injections.
import { after, afterEach, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

class FakeClassList {
  private readonly names = new Set<string>();
  add(name: string) {
    this.names.add(name);
  }
  remove(name: string) {
    this.names.delete(name);
  }
  contains(name: string) {
    return this.names.has(name);
  }
  get value() {
    return [...this.names].sort().join(" ");
  }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly children: unknown[] = [];
  private readonly attributes = new Map<string, string>();
  attributeWrites = 0;
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributeWrites++;
    this.attributes.set(name, value);
  }
  appendChild(child: unknown) {
    this.children.push(child);
    return child;
  }
  removeChild(child: unknown) {
    this.children.splice(this.children.indexOf(child), 1);
    return child;
  }
}

type Listener = (event: unknown) => void;

interface StorageEventFields {
  key: string | null;
  oldValue: string | null;
  newValue: string | null;
  storageArea: unknown;
}

/** What `useStorage` dispatches on the window after writing a `Storage`. */
class FakeStorageEvent {
  constructor(
    readonly type: string,
    init: StorageEventFields,
  ) {
    Object.assign(this, init);
  }
}

/** `useStorage` listens for cross-tab `storage` events only on a `Storage`. */
class FakeStorage {
  readonly items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

/** One `window` + `document` pair, reset between cases. */
function createDom() {
  const html = new FakeElement();
  const head = new FakeElement();
  const listeners = new Map<string, Set<Listener>>();
  const localStorage = new FakeStorage();
  const counts = { forcedRecalcs: 0, sheetsInjected: 0 };
  let prefersDark = false;
  const document = {
    documentElement: html,
    head,
    querySelector: (selector: string) => (selector === "html" ? html : null),
    createElement: (tag: string) => {
      if (tag === "style") counts.sheetsInjected++;
      return new FakeElement();
    },
    createTextNode: (text: string) => ({ text }),
  };
  const window = {
    document,
    localStorage,
    matchMedia: (query: string) => ({
      matches: query.includes("dark") ? prefersDark : false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }),
    getComputedStyle: () => {
      counts.forcedRecalcs++;
      return { opacity: "1" };
    },
    addEventListener: (type: string, listener: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: () => true,
  };
  return {
    html,
    head,
    window,
    document,
    localStorage,
    counts,
    /** What the browser fires when another tab writes the key. */
    storageEvent: (key: string, newValue: string) => {
      localStorage.setItem(key, newValue);
      for (const listener of listeners.get("storage") ?? []) {
        listener({ key, newValue, storageArea: localStorage });
      }
    },
    setPrefersDark: (value: boolean) => {
      prefersDark = value;
    },
  };
}

const dom = createDom();
const saved = {
  window: globalThis.window,
  document: globalThis.document,
  Storage: globalThis.Storage,
  StorageEvent: globalThis.StorageEvent,
};
let vue: typeof import("vue");
let vueuse: typeof import("@vueuse/core");

before(async () => {
  // vueuse decides `isClient` and its default window when the module loads.
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.document,
    Storage: FakeStorage,
    StorageEvent: FakeStorageEvent,
  });
  vue = await import("vue");
  vueuse = await import("@vueuse/core");
});

after(() => {
  Object.assign(globalThis, saved);
});

const scopes: Array<{ stop(): void }> = [];

function reset({
  htmlClasses = [] as string[],
  stored = null as string | null,
} = {}) {
  for (const name of dom.html.classList.value.split(" ").filter(Boolean)) {
    dom.html.classList.remove(name);
  }
  for (const name of htmlClasses) dom.html.classList.add(name);
  dom.localStorage.items.clear();
  if (stored !== null) dom.localStorage.setItem("vueuse-color-scheme", stored);
  dom.setPrefersDark(false);
  dom.counts.forcedRecalcs = 0;
  dom.counts.sheetsInjected = 0;
  dom.html.attributeWrites = 0;
}

/** useColorMode inside its own scope, the way a plugin or component holds it. */
function colorMode(options: Parameters<typeof vueuse.useColorMode>[0] = {}) {
  const scope = vue.effectScope();
  scopes.push(scope);
  return scope.run(() => vueuse.useColorMode(options))!;
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop();
});

describe("vueuse useColorMode patch", () => {
  it("is the version the workspace pins and patches", () => {
    const template = JSON.parse(
      readFileSync(join("templates", "vue", "package.json"), "utf8"),
    );
    const installed = JSON.parse(
      readFileSync(
        join("node_modules", "@vueuse", "core", "package.json"),
        "utf8",
      ),
    );
    assert.equal(template.dependencies["@vueuse/core"], installed.version);
    assert.match(
      readFileSync(join("templates", "vue", "pnpm-workspace.yaml"), "utf8"),
      new RegExp(
        `"@vueuse/core@${installed.version}": patches/@vueuse__core@${installed.version}\\.patch`,
      ),
    );
  });

  it("leaves a class mode the element already carries alone", async () => {
    reset({ htmlClasses: ["light"], stored: "light" });
    // Nuxt UI's plugin, the dms theme plugin and every component calling it:
    // each instance applies its mode immediately and again once mounted.
    colorMode();
    colorMode({ storageKey: "other-key", initialValue: "light" });
    await vue.nextTick();
    assert.equal(dom.counts.forcedRecalcs, 0);
    assert.equal(dom.counts.sheetsInjected, 0);
    assert.equal(dom.html.classList.value, "light");
  });

  it("switches classes, without transitions, when the mode changes", async () => {
    reset({ htmlClasses: ["light"], stored: "light" });
    const mode = colorMode();
    await vue.nextTick();
    mode.value = "dark";
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "dark");
    assert.equal(dom.counts.forcedRecalcs, 1);
    assert.equal(dom.counts.sheetsInjected, 1);
    assert.equal(
      dom.head.children.length,
      0,
      "the transition sheet is removed",
    );
    mode.value = "light";
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "light");
    assert.equal(dom.counts.forcedRecalcs, 2);
  });

  it("applies the stored mode when the element carries another one", async () => {
    reset({ htmlClasses: ["light"], stored: "dark" });
    colorMode();
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "dark");
    assert.equal(
      dom.counts.forcedRecalcs,
      1,
      "applied once, the mount re-run is a no-op",
    );
  });

  it("applies a mode another tab stores", async () => {
    reset({ htmlClasses: ["light"], stored: "light" });
    colorMode();
    await vue.nextTick();
    dom.storageEvent("vueuse-color-scheme", "dark");
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "dark");
    assert.equal(dom.counts.forcedRecalcs, 1);
  });

  it("follows the system preference in auto mode", async () => {
    reset({ htmlClasses: ["dark"], stored: "auto" });
    dom.setPrefersDark(true);
    colorMode();
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "dark");
    assert.equal(dom.counts.forcedRecalcs, 0);

    reset({ htmlClasses: ["dark"], stored: "auto" });
    colorMode();
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "light");
    assert.equal(dom.counts.forcedRecalcs, 1);
  });

  it("adds only the missing class of a multi-class mode", async () => {
    reset({ htmlClasses: ["dark"], stored: "dark" });
    colorMode({ modes: { dark: "dark dim" } });
    await vue.nextTick();
    assert.equal(dom.html.classList.value, "dark dim");
    assert.equal(dom.counts.forcedRecalcs, 1);
  });

  it("writes an attribute mode only when its value differs", async () => {
    reset({ stored: "dark" });
    dom.html.setAttribute("data-theme", "dark");
    dom.html.attributeWrites = 0;
    const mode = colorMode({ attribute: "data-theme" });
    await vue.nextTick();
    assert.equal(dom.html.attributeWrites, 0);
    assert.equal(dom.counts.forcedRecalcs, 0);
    mode.value = "light";
    await vue.nextTick();
    assert.equal(dom.html.getAttribute("data-theme"), "light");
    assert.equal(dom.html.attributeWrites, 1);
    assert.equal(dom.counts.forcedRecalcs, 1);
  });
});
