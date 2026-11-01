import type {
  BackendProxyDeclaration,
  FrontendModuleOptions,
  FrontendModuleValue,
  Manifest,
  ManifestModule,
  OriginRewrite,
  PublicEndpointDeclaration,
} from "../workspace";
import { isFlag, isNumber, isText } from "./guards";
import { isPlainObject } from "./plain-object";

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isTextList(value: unknown): value is string[] {
  return isList(value) && value.every(isText);
}

function isModuleValue(value: unknown): value is FrontendModuleValue {
  if (value === null || isText(value) || isNumber(value) || isFlag(value))
    return true;
  return isList(value) ? value.every(isModuleValue) : isModuleOptions(value);
}

function isModuleOptions(value: unknown): value is FrontendModuleOptions {
  return isPlainObject(value) && Object.values(value).every(isModuleValue);
}

function isPublicEndpoint(value: unknown): value is PublicEndpointDeclaration {
  return (
    isPlainObject(value) &&
    isText(value.path) &&
    (value.methods === undefined || isTextList(value.methods)) &&
    (value.headers === undefined || isTextList(value.headers))
  );
}

function isBackendProxy(value: unknown): value is BackendProxyDeclaration {
  return (
    isPlainObject(value) &&
    isText(value.path) &&
    (value.auth === undefined ||
      value.auth === "session" ||
      value.auth === "none") &&
    (value.maxBodyBytes === undefined || isNumber(value.maxBodyBytes))
  );
}

function isRenderer(
  value: unknown,
): value is { name: string; version: string } {
  return isPlainObject(value) && isText(value.name) && isText(value.version);
}

type OptionalFields = Pick<
  ManifestModule,
  "renderer" | "path" | "options" | "privateOptions" | "configKey"
>;

type OptionalLists = Pick<
  ManifestModule,
  "authEstablishEndpoints" | "publicEndpoints" | "backendProxies"
>;

function hasOptionalFields(value: unknown): value is OptionalFields {
  return (
    isPlainObject(value) &&
    (value.renderer === undefined || isRenderer(value.renderer)) &&
    (value.path === undefined || isText(value.path)) &&
    (value.options === undefined || isModuleOptions(value.options)) &&
    (value.privateOptions === undefined ||
      isModuleOptions(value.privateOptions)) &&
    (value.configKey === undefined || isText(value.configKey))
  );
}

function hasOptionalLists(value: unknown): value is OptionalLists {
  return (
    isPlainObject(value) &&
    (value.authEstablishEndpoints === undefined ||
      isTextList(value.authEstablishEndpoints)) &&
    (value.publicEndpoints === undefined ||
      (isList(value.publicEndpoints) &&
        value.publicEndpoints.every(isPublicEndpoint))) &&
    (value.backendProxies === undefined ||
      (isList(value.backendProxies) &&
        value.backendProxies.every(isBackendProxy)))
  );
}

/**
 * Whether `value` holds every field of a `ManifestModule` at the type the
 * interface declares. Fields the interface does not name are not read.
 *
 * @internal
 */
export function isManifestModule(value: unknown): value is ManifestModule {
  return (
    isPlainObject(value) &&
    isText(value.name) &&
    isNumber(value.priority) &&
    hasOptionalFields(value) &&
    hasOptionalLists(value)
  );
}

function isOriginRewrite(value: unknown): value is OriginRewrite {
  return isPlainObject(value) && isText(value.from) && isText(value.to);
}

/**
 * Whether `value` is a `Manifest`: a list of modules, a settling flag that is
 * true or false, and origin rewrites that name a `from` and a `to`.
 *
 * @internal
 */
export function isManifest(value: unknown): value is Manifest {
  return (
    isPlainObject(value) &&
    isList(value.modules) &&
    value.modules.every(isManifestModule) &&
    (value.settling === undefined || isFlag(value.settling)) &&
    (value.originRewrites === undefined ||
      (isList(value.originRewrites) &&
        value.originRewrites.every(isOriginRewrite)))
  );
}

/**
 * Whether `value` is a manifest document that states its protocol version.
 *
 * @internal
 */
export function hasManifestVersion(
  value: unknown,
): value is { version: number } {
  return isPlainObject(value) && isNumber(value.version);
}
