/** Public options by module id, as `ajs dms start` computes them. */
export type DmsPublicOptionsById = Record<string, Record<string, unknown>>;

function isModuleOptions(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPublicOptionsById(value: unknown): value is DmsPublicOptionsById {
  return isModuleOptions(value) && Object.values(value).every(isModuleOptions);
}

/** `DMS_PUBLIC_OPTIONS` as options by module id, undefined when unset. */
export function parsePublicOptions(
  raw: string | null | undefined,
): DmsPublicOptionsById | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPublicOptionsById(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
