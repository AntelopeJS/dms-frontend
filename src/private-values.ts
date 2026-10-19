// Private module options are the secrets a backend serves the frontend. They
// are needed by the running server only, which reads them from its
// environment, so nothing a build writes keeps their values.

import { UsageError } from "./config";
import type {
  FrontendModuleOptions,
  FrontendModuleValue,
  ManifestModule,
} from "./workspace";

function emptied(value: FrontendModuleValue): FrontendModuleValue {
  if (typeof value === "string") return "";
  if (Array.isArray(value)) return value.map(emptied);
  if (value !== null && typeof value === "object") return emptiedOptions(value);
  return value;
}

function emptiedOptions(options: FrontendModuleOptions): FrontendModuleOptions {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, emptied(value)]),
  );
}

/**
 * The modules with every string of their private options emptied. The shape
 * stays: the generated server fills an empty secret from its environment
 * (`DMS_HTML_RENDER_SECRET`, `DMS_OAUTH_RELAY_SECRET`, or any of them from
 * `DMS_PRIVATE_OPTIONS`), and only a section that exists can be filled.
 *
 * @param modules Modules as the backend served them
 */
export function withoutPrivateValues(
  modules: readonly ManifestModule[],
): ManifestModule[] {
  return modules.map((module) =>
    module.privateOptions
      ? { ...module, privateOptions: emptiedOptions(module.privateOptions) }
      : { ...module },
  );
}

/** The variable that carries any module's private options to the server. */
export const PRIVATE_OPTIONS_VARIABLE = "DMS_PRIVATE_OPTIONS";

/** A private value the server receives empty, named by module id and path. */
export interface UnfilledPrivateValue {
  module: string;
  path: string[];
}

function isOptions(value: unknown): value is FrontendModuleOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `DMS_PRIVATE_OPTIONS` as private options by module id, empty when unset.
 *
 * @throws UsageError when it is not a JSON object of objects; the message
 *   never repeats its content
 */
export function parsePrivateOptions(
  raw: string | undefined,
): Record<string, FrontendModuleOptions> {
  if (!raw?.trim()) return {};
  let given: unknown;
  try {
    given = JSON.parse(raw);
  } catch {
    given = undefined;
  }
  if (!isOptions(given) || !Object.values(given).every(isOptions)) {
    throw new UsageError({
      title: `${PRIVATE_OPTIONS_VARIABLE} is not a JSON object of options by module id`,
      fixes: [
        `Set it like ${PRIVATE_OPTIONS_VARIABLE}='{"<module id>":{"<option>":"<value>"}}', with the ids of generated-server-options.json`,
      ],
    });
  }
  return given as Record<string, FrontendModuleOptions>;
}

function readPath(options: unknown, path: readonly string[]): unknown {
  let value = options;
  for (const key of path) {
    if (!isOptions(value)) return undefined;
    value = value[key];
  }
  return value;
}

function* emptyStrings(
  value: unknown,
  path: string[] = [],
): Generator<string[]> {
  if (value === "") yield path;
  else if (isOptions(value))
    for (const [key, child] of Object.entries(value))
      yield* emptyStrings(child, [...path, key]);
}

/**
 * The private values still empty once the server's environment has filled
 * them: those `given` (from `DMS_PRIVATE_OPTIONS`) does not set and `covered`
 * (paths a named variable fills, reported on their own) does not list.
 *
 * @param modules The private options by module id, as the build wrote them
 */
export function unfilledPrivateValues(
  modules: Readonly<Record<string, FrontendModuleOptions>>,
  given: Readonly<Record<string, FrontendModuleOptions>>,
  covered: readonly (readonly string[])[],
): UnfilledPrivateValue[] {
  const isCovered = (path: string[]) =>
    covered.some(
      (other) =>
        other.length === path.length &&
        other.every((key, index) => key === path[index]),
    );
  return Object.entries(modules).flatMap(([module, options]) =>
    [...emptyStrings(options)]
      .filter((path) => path.length > 0 && !isCovered(path))
      .filter((path) => {
        const value = readPath(given[module], path);
        return typeof value !== "string" || value === "";
      })
      .map((path) => ({ module, path })),
  );
}
