/** Public options by module id, as `ajs dms start` computes them. */
export type DmsPublicOptionsById = Record<string, Record<string, unknown>>;

/** `DMS_PUBLIC_OPTIONS` as options by module id, undefined when unset. */
export function parsePublicOptions(
  raw: string | null | undefined,
): DmsPublicOptionsById | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as DmsPublicOptionsById)
      : undefined;
  } catch {
    return undefined;
  }
}
