// The DMS app config the layers' `app/app.config.ts` make, and how an edited
// one reaches it while the page is open in development.
//
// Lives apart from frontend-module.ts so the merge can be exercised on its own,
// the way ui-app-config.ts is.

import { defu } from "defu";
import { clonePlain, isPlainRecord, type PlainRecord } from "./ui-app-config";

/**
 * The layer configs, highest precedence first, merged into a new object that
 * shares nothing with them: the modules extend what this returns, and must not
 * write into a config module's exports, which a development server keeps from
 * one setup of the modules to the next.
 */
export function mergeLayerAppConfigs(configs: readonly unknown[]): PlainRecord {
  return defu({}, ...configs.filter(isPlainRecord).map(clonePlain));
}

function isSameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right))
    return (
      left.length === right.length &&
      left.every((item, index) => isSameValue(item, right[index]))
    );
  if (isPlainRecord(left) && isPlainRecord(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && isSameValue(left[key], right[key]))
    );
  }
  return Object.is(left, right);
}

/**
 * What `after` holds that `before` does not: each value added or changed, down
 * through the records both hold. An array counts as one value.
 */
export function appConfigChanges(
  before: PlainRecord,
  after: PlainRecord,
): PlainRecord {
  const changes: PlainRecord = {};
  for (const [key, value] of Object.entries(after)) {
    const previous = before[key];
    if (isPlainRecord(previous) && isPlainRecord(value)) {
      const nested = appConfigChanges(previous, value);
      if (Object.keys(nested).length > 0) changes[key] = nested;
    } else if (!isSameValue(previous, value)) {
      changes[key] = clonePlain(value);
    }
  }
  return changes;
}

/**
 * `config` with `changes` on top: a record both hold is merged, anything else
 * the changes hold replaces what `config` has, arrays included.
 */
export function withAppConfigChanges(
  config: PlainRecord,
  changes: PlainRecord,
): PlainRecord {
  const result = { ...config };
  for (const [key, value] of Object.entries(changes)) {
    const current = result[key];
    result[key] =
      isPlainRecord(current) && isPlainRecord(value)
        ? withAppConfigChanges(current, value)
        : clonePlain(value);
  }
  return result;
}

/**
 * Make `target` hold what `source` holds, in place: a record both hold is
 * updated rather than replaced, so whoever kept it, a component reading
 * `useDmsAppConfig().branding` for instance, sees the new values too, and a
 * key `source` no longer has is removed.
 */
export function assignInPlace(target: PlainRecord, source: PlainRecord): void {
  for (const key of Object.keys(target)) {
    if (!(key in source)) delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    const current = target[key];
    if (isPlainRecord(current) && isPlainRecord(value))
      assignInPlace(current, value);
    else target[key] = value;
  }
}
