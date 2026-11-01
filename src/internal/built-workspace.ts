import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SERVER_OPTIONS_FILE } from "../config";
import type { ServedModule } from "../module-set";
import type { FrontendModuleOptions, FrontendModuleValue } from "../workspace";
import { isFlag, isNumber, isText } from "./guards";
import { isPlainObject } from "./plain-object";

function isModuleValue(value: unknown): value is FrontendModuleValue {
  if (value === null || isText(value) || isNumber(value) || isFlag(value))
    return true;
  return Array.isArray(value)
    ? value.every(isModuleValue)
    : isModuleOptions(value);
}

function isModuleOptions(value: unknown): value is FrontendModuleOptions {
  return isPlainObject(value) && Object.values(value).every(isModuleValue);
}

function isOptionsById(
  value: unknown,
): value is Record<string, FrontendModuleOptions> {
  return isPlainObject(value) && Object.values(value).every(isModuleOptions);
}

/**
 * The private options by module id the build wrote, none when the file is
 * missing, unreadable or not what the build writes.
 *
 * @internal
 */
export function readBuiltPrivateOptions(
  workspaceDir: string,
): Record<string, FrontendModuleOptions> {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(workspaceDir, SERVER_OPTIONS_FILE), "utf8"),
    );
    const modules = isPlainObject(parsed) ? parsed.modules : undefined;
    return isOptionsById(modules) ? modules : {};
  } catch {
    return {};
  }
}

/**
 * The modules the build serves, from the registry its server reads. A module
 * that has no text id is left out; none when the registry is unreadable.
 *
 * @internal
 */
export function readBuiltModules(workspaceDir: string): ServedModule[] {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(
        join(workspaceDir, "generated-frontend-modules.json"),
        "utf8",
      ),
    );
    const modules: unknown = isPlainObject(parsed) ? parsed.modules : undefined;
    if (!Array.isArray(modules)) return [];
    const listed: unknown[] = modules;
    return listed.flatMap((module) =>
      isPlainObject(module) && isText(module.id)
        ? [
            {
              name: isText(module.name) ? module.name : module.id,
              version: isText(module.version) ? module.version : undefined,
            },
          ]
        : [],
    );
  } catch {
    return [];
  }
}
