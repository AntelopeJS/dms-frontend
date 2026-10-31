import { UsageError } from "./config";
import { isObjectLike, isText } from "./internal/guards";
import type { FrontendModuleOptions, FrontendModuleValue } from "./workspace";

type OptionValue = FrontendModuleValue | undefined;

function isOptions(value: OptionValue): value is FrontendModuleOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContainer(
  value: OptionValue,
): value is FrontendModuleOptions | FrontendModuleValue[] {
  return typeof value === "object" && value !== null;
}

function emptied(value: FrontendModuleValue): FrontendModuleValue {
  if (isText(value)) return "";
  if (Array.isArray(value)) return value.map(emptied);
  if (isOptions(value)) return emptiedOptions(value);
  return value;
}

/**
 * Private options with every string emptied. The shape stays: the generated
 * server fills an empty secret from its environment (`DMS_HTML_RENDER_SECRET`,
 * `DMS_OAUTH_RELAY_SECRET`, or any of them from `DMS_PRIVATE_OPTIONS`), and
 * only a section that exists can be filled.
 *
 * Private module options are the secrets a backend serves the frontend. They
 * are needed by the running server only, which reads them from its environment,
 * so nothing a build writes keeps their values.
 */
export function emptiedOptions(
  options: FrontendModuleOptions,
): FrontendModuleOptions {
  return Object.fromEntries(
    Object.entries(options).map(([key, value]) => [key, emptied(value)]),
  );
}

function filled(
  declared: FrontendModuleValue,
  value: OptionValue,
): FrontendModuleValue {
  if (isText(declared)) return isText(value) ? value : "";
  if (Array.isArray(declared))
    return declared.map((item, index) =>
      filled(item, Array.isArray(value) ? value[index] : undefined),
    );
  if (isOptions(declared))
    return filledOptions(declared, isOptions(value) ? value : undefined);
  return declared;
}

/**
 * Private options in the shape a module's `frontendModule` returns, each
 * string taken from `values` at the same path: what `start` fills from its
 * environment, `dev` fills from the backend. A value outside the shape is
 * left out, as it would be in production.
 */
export function filledOptions(
  shape: FrontendModuleOptions,
  values: FrontendModuleOptions | undefined,
): FrontendModuleOptions {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => [
      key,
      filled(value, values?.[key]),
    ]),
  );
}

/** The variable that carries any module's private options to the server. */
export const PRIVATE_OPTIONS_VARIABLE = "DMS_PRIVATE_OPTIONS";

/** A private value the server receives empty, named by module id and path. */
export interface UnfilledPrivateValue {
  module: string;
  path: string[];
}

function isOptionsById(
  value: unknown,
): value is Record<string, FrontendModuleOptions> {
  return (
    isObjectLike(value) &&
    !Array.isArray(value) &&
    Object.values(value).every(isOptions)
  );
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
  if (!isOptionsById(given)) {
    throw new UsageError({
      title: `${PRIVATE_OPTIONS_VARIABLE} is not a JSON object of options by module id`,
      fixes: [
        `Set it like ${PRIVATE_OPTIONS_VARIABLE}='{"<module id>":{"<option>":"<value>"}}', with the ids of generated-server-options.json`,
      ],
    });
  }
  return given;
}

function readPath(options: OptionValue, path: readonly string[]): OptionValue {
  let value = options;
  for (const key of path) {
    if (!isContainer(value)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = isOptions(value) ? value[key] : value[Number(key)];
  }
  return value;
}

function* emptyStrings(
  value: OptionValue,
  path: string[] = [],
): Generator<string[]> {
  if (value === "") yield path;
  else if (isContainer(value))
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
        const value = readPath(
          Object.prototype.hasOwnProperty.call(given, module)
            ? given[module]
            : undefined,
          path,
        );
        return !isText(value) || value === "";
      })
      .map((path) => ({ module, path })),
  );
}
