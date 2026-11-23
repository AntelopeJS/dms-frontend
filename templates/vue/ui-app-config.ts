import { defu } from "defu";

/** A config object, whose values are the config's own to give. */
export type PlainRecord = Record<string, unknown>;

/** The value under a key of a config object. */
export type PlainValue = PlainRecord[string];

interface MergeState {
  pristine: PlainRecord;
  mergedFrom: PlainRecord | null;
}

interface MergeOptions {
  /**
   * The DMS config was merged before and has changed since, in place: its
   * identity alone cannot tell.
   */
  isChanged?: boolean;
}

export function isPlainRecord(value: PlainValue): value is PlainRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** A deep copy of the records and arrays in `record`, sharing anything else. */
export function clonePlainRecord(record: PlainRecord): PlainRecord {
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, clonePlain(entry)]),
  );
}

/** A deep copy of the records and arrays in `value`, sharing anything else. */
export function clonePlain(value: PlainValue): PlainValue {
  if (Array.isArray(value)) return value.map(clonePlain);
  if (!isPlainRecord(value)) return value;
  return clonePlainRecord(value);
}

function replaceInPlace(target: PlainRecord, source: PlainRecord): void {
  for (const key of Object.keys(target)) {
    if (!Object.hasOwn(source, key)) delete target[key];
  }
  Object.assign(target, source);
}

/**
 * Merges the DMS app config into Nuxt UI's, which lives for the whole process.
 * Each DMS config is merged once, so arrays that defu concatenates never pile
 * up across renders. A new DMS config, after a development reload, replaces
 * the previous merge: Nuxt UI's object is reset to its own values first, so
 * changed and removed keys both reach the next server render. So does a DMS
 * config a layer's edited app config changed in place, in the browser, once
 * the caller says so.
 */
export function createUiAppConfigMerger(): (
  uiAppConfig: PlainRecord,
  dmsAppConfig: PlainRecord,
  options?: MergeOptions,
) => void {
  const states = new WeakMap<object, MergeState>();
  return (uiAppConfig, dmsAppConfig, { isChanged = false } = {}) => {
    let state = states.get(uiAppConfig);
    if (state === undefined) {
      state = {
        pristine: clonePlainRecord({ ...uiAppConfig }),
        mergedFrom: null,
      };
      states.set(uiAppConfig, state);
    }
    if (state.mergedFrom === dmsAppConfig && !isChanged) return;
    replaceInPlace(
      uiAppConfig,
      defu(clonePlainRecord(dmsAppConfig), clonePlainRecord(state.pristine)),
    );
    state.mergedFrom = dmsAppConfig;
  };
}
