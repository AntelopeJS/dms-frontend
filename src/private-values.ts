// Private module options are the secrets a backend serves the frontend. They
// are needed by the running server only, which reads them from its
// environment, so nothing a build writes keeps their values.

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
 * (`DMS_HTML_RENDER_SECRET`, `DMS_OAUTH_RELAY_SECRET`), and only a section
 * that exists can be filled.
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
