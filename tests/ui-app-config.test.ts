import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createUiAppConfigMerger } from "../templates/vue/ui-app-config";

function nuxtUiConfig() {
  return {
    ui: {
      colors: { primary: "green", neutral: "slate" },
      button: { compoundVariants: [{ color: "neutral", class: "base" }] },
    },
  } as Record<string, unknown>;
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
    assert.deepEqual(
      (ui.ui as { button: { compoundVariants: unknown[] } }).button
        .compoundVariants,
      [
        { color: "primary", class: "dms" },
        { color: "neutral", class: "base" },
      ],
    );
  });

  it("applies a changed value from a new DMS config, in the same object", () => {
    const merge = createUiAppConfigMerger();
    const ui = nuxtUiConfig();
    const sameObject = ui;
    merge(ui, { ui: { colors: { primary: "v1" } } });
    merge(ui, { ui: { colors: { primary: "v2" } } });
    assert.equal(ui, sameObject);
    assert.deepEqual((ui.ui as { colors: unknown }).colors, {
      primary: "v2",
      neutral: "slate",
    });
  });

  it("drops a key the new DMS config no longer declares", () => {
    const merge = createUiAppConfigMerger();
    const ui = nuxtUiConfig();
    merge(ui, { ui: { icons: { check: "i-ph-check-light" } }, brand: "old" });
    merge(ui, { ui: {} });
    assert.equal((ui.ui as { icons?: unknown }).icons, undefined);
    assert.equal(ui.brand, undefined);
    assert.deepEqual((ui.ui as { colors: unknown }).colors, {
      primary: "green",
      neutral: "slate",
    });
  });

  it("never lets a merge write into the DMS config", () => {
    const merge = createUiAppConfigMerger();
    const dms = { ui: { colors: { primary: "v1" } } };
    merge(nuxtUiConfig(), dms);
    assert.deepEqual(dms, { ui: { colors: { primary: "v1" } } });
  });
});
