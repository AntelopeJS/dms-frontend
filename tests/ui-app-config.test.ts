import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUiAppConfigMerger } from "../templates/vue/ui-app-config";

type NuxtUiConfig = {
  ui: {
    colors: Record<string, string>;
    button: { compoundVariants: Array<{ color: string; class: string }> };
    icons?: Record<string, string>;
  };
  brand?: string;
};

function nuxtUiConfig(): NuxtUiConfig {
  return {
    ui: {
      colors: { primary: "green", neutral: "slate" },
      button: { compoundVariants: [{ color: "neutral", class: "base" }] },
    },
  };
}

describe("merging the DMS app config into Nuxt UI's", () => {
  it("merges one DMS config once, however many renders ask for it", () => {
    const merge = createUiAppConfigMerger();
    const ui = nuxtUiConfig();
    const dms = {
      ui: {
        button: { compoundVariants: [{ color: "primary", class: "dms" }] },
      },
    };
    merge(ui, dms);
    merge(ui, dms);
    merge(ui, dms);
    assert.deepEqual(ui.ui.button.compoundVariants, [
      { color: "primary", class: "dms" },
      { color: "neutral", class: "base" },
    ]);
  });

  it("applies a changed value from a new DMS config, in the same object", () => {
    const merge = createUiAppConfigMerger();
    const ui = nuxtUiConfig();
    const sameObject = ui;
    merge(ui, { ui: { colors: { primary: "v1" } } });
    merge(ui, { ui: { colors: { primary: "v2" } } });
    assert.equal(ui, sameObject);
    assert.deepEqual(ui.ui.colors, {
      primary: "v2",
      neutral: "slate",
    });
  });

  it("drops a key the new DMS config no longer declares", () => {
    const merge = createUiAppConfigMerger();
    const ui = nuxtUiConfig();
    merge(ui, { ui: { icons: { check: "i-ph-check-light" } }, brand: "old" });
    merge(ui, { ui: {} });
    assert.equal(ui.ui.icons, undefined);
    assert.equal(ui.brand, undefined);
    assert.deepEqual(ui.ui.colors, {
      primary: "green",
      neutral: "slate",
    });
  });

  it("merges a DMS config changed in place again when told it changed", () => {
    const merge = createUiAppConfigMerger();
    const ui = nuxtUiConfig();
    const dms = {
      ui: {
        colors: { primary: "v1" },
        button: { compoundVariants: [{ color: "primary", class: "dms" }] },
      },
    };
    merge(ui, dms);
    dms.ui.colors.primary = "v2";
    merge(ui, dms);
    assert.deepEqual(ui.ui.colors, { primary: "v1", neutral: "slate" });

    merge(ui, dms, { isChanged: true });
    assert.deepEqual(ui.ui.colors, { primary: "v2", neutral: "slate" });
    assert.deepEqual(ui.ui.button.compoundVariants, [
      { color: "primary", class: "dms" },
      { color: "neutral", class: "base" },
    ]);
  });

  it("never lets a merge write into the DMS config", () => {
    const merge = createUiAppConfigMerger();
    const dms = { ui: { colors: { primary: "v1" } } };
    merge(nuxtUiConfig(), dms);
    assert.deepEqual(dms, { ui: { colors: { primary: "v1" } } });
  });
});
