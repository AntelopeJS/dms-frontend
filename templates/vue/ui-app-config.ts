import { defu } from "defu";

type PlainRecord = Record<string, unknown>;

interface MergeState {
  pristine: PlainRecord;
  mergedFrom: object | null;
}

function isPlainRecord(value: unknown): value is PlainRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function clonePlain<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clonePlain) as T;
  if (!isPlainRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, clonePlain(entry)]),
  ) as T;
}

function replaceInPlace(target: PlainRecord, source: PlainRecord): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  Object.assign(target, source);
}

/**
 * Merges the DMS app config into Nuxt UI's, which lives for the whole process.
 * Each DMS config is merged once, so arrays that defu concatenates never pile
 * up across renders. A new DMS config, after a development reload, replaces
 * the previous merge: Nuxt UI's object is reset to its own values first, so
 * changed and removed keys both reach the next server render.
 */
export function createUiAppConfigMerger(): (
  uiAppConfig: PlainRecord,
  dmsAppConfig: object,
) => void {
  const states = new WeakMap<object, MergeState>();
  return (uiAppConfig, dmsAppConfig) => {
    let state = states.get(uiAppConfig);
    if (state === undefined) {
      state = { pristine: clonePlain({ ...uiAppConfig }), mergedFrom: null };
      states.set(uiAppConfig, state);
    }
    if (state.mergedFrom === dmsAppConfig) return;
    replaceInPlace(
      uiAppConfig,
      defu(clonePlain(dmsAppConfig), clonePlain(state.pristine)),
    );
    state.mergedFrom = dmsAppConfig;
  };
}
