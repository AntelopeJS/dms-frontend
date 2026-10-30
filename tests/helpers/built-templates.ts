import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isCallable, isObjectLike } from "./guards";

type Server = typeof import("../../templates/vue/server.mjs");
type Session = typeof import("../../templates/vue/server/auth/session.mjs");
type ModuleServer =
  typeof import("../../templates/vue/server/module-server.mjs");
type Email = typeof import("../../templates/vue/server/email.mjs");

/** What the tests call on the `server.mjs` copied into a built workspace. */
export type BuiltServer = Pick<Server, "handleRequestSafely">;
/** What the tests call on the `server/auth/session.mjs` of a built workspace. */
export type BuiltSession = Pick<
  Session,
  "readSession" | "writeSealedCookie" | "writeSession"
>;
/** What the tests call on the `server/module-server.mjs` of a built workspace. */
export type BuiltModuleServer = Pick<
  ModuleServer,
  "handleModuleRoute" | "loadServerModules"
>;

/** What the tests call on the `server/email.mjs` of a built workspace. */
export type BuiltEmail = Pick<
  Email,
  "renderEmailTemplate" | "watchEmailBundle"
>;

function isBuiltServer(value: unknown): value is BuiltServer {
  return (
    isObjectLike(value) &&
    "handleRequestSafely" in value &&
    isCallable(value.handleRequestSafely)
  );
}

function isBuiltSession(value: unknown): value is BuiltSession {
  return (
    isObjectLike(value) &&
    "readSession" in value &&
    isCallable(value.readSession) &&
    "writeSealedCookie" in value &&
    isCallable(value.writeSealedCookie) &&
    "writeSession" in value &&
    isCallable(value.writeSession)
  );
}

function isBuiltModuleServer(value: unknown): value is BuiltModuleServer {
  return (
    isObjectLike(value) &&
    "handleModuleRoute" in value &&
    isCallable(value.handleModuleRoute) &&
    "loadServerModules" in value &&
    isCallable(value.loadServerModules)
  );
}

/** The `server.mjs` of a built workspace, which the build wrote there. */
export async function builtServer(workspace: string): Promise<BuiltServer> {
  const loaded: unknown = await import(
    pathToFileURL(join(workspace, "server.mjs")).href
  );
  assert.ok(isBuiltServer(loaded), "server.mjs exports handleRequestSafely");
  return loaded;
}

/** The `server/auth/session.mjs` of a built workspace. */
export async function builtSession(workspace: string): Promise<BuiltSession> {
  const loaded: unknown = await import(
    pathToFileURL(join(workspace, "server/auth/session.mjs")).href
  );
  assert.ok(isBuiltSession(loaded), "session.mjs exports the session helpers");
  return loaded;
}

/** The `server/module-server.mjs` of a built workspace. */
export async function builtModuleServer(
  workspace: string,
): Promise<BuiltModuleServer> {
  const loaded: unknown = await import(
    pathToFileURL(join(workspace, "server/module-server.mjs")).href
  );
  assert.ok(
    isBuiltModuleServer(loaded),
    "module-server.mjs exports the module route handlers",
  );
  return loaded;
}

function isBuiltEmail(value: unknown): value is BuiltEmail {
  return (
    isObjectLike(value) &&
    "renderEmailTemplate" in value &&
    isCallable(value.renderEmailTemplate) &&
    "watchEmailBundle" in value &&
    isCallable(value.watchEmailBundle)
  );
}

/** The `server/email.mjs` of a built workspace. */
export async function builtEmail(workspace: string): Promise<BuiltEmail> {
  const loaded: unknown = await import(
    pathToFileURL(join(workspace, "server/email.mjs")).href
  );
  assert.ok(isBuiltEmail(loaded), "email.mjs exports the email render helpers");
  return loaded;
}
