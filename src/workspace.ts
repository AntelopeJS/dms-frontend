// Manifest and layer types, and the per-backend workspace directory: where it
// lives, how its key is derived, and how its metadata is written.
//
// Split out of common.ts, which stays the barrel every command imports from.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  DMS_FRONTEND_HOME,
  WORKSPACE_DIR_MODE,
  canonicalizeBackendUrl,
  sha256Hex,
} from "./config";

// ============================================================================
// Constants
// ============================================================================

/** Marks a directory under the loader home as a workspace this CLI owns. */
const WORKSPACE_META_FILE = ".ajs-dms-meta.json";

export type FrontendModuleValue =
  | string
  | number
  | boolean
  | null
  | FrontendModuleValue[]
  | FrontendModuleOptions;

export interface FrontendModuleOptions {
  [key: string]: FrontendModuleValue;
}

export interface ManifestModule {
  name: string;
  archiveName: string;
  renderer?: { name: string; version: string };
  /**
   * Absolute source directory on the backend machine. Only served by a
   * development backend to an authenticated caller, since it is meaningless
   * — and a disclosure — anywhere the sources are not on the same disk.
   * Build mode never reads it.
   */
  path?: string;
  priority: number;
  options?: FrontendModuleOptions;
  /**
   * Secrets the backend serves to an authenticated caller. The loader itself
   * consumes none of them — the generated server reads its OAuth relay and
   * HTML render secrets from the environment — but they land verbatim in the
   * manifest cache, which is why that file is written 0600.
   */
  privateOptions?: FrontendModuleOptions;
  configKey?: string;
  /**
   * Absolute backend API paths this module declared as session-opening: the
   * generated server accepts them on `/auth/establish`. Served only to an
   * authenticated caller, and absent from a manifest produced by a DMS that
   * predates the field.
   */
  authEstablishEndpoints?: string[];
}

export interface Manifest {
  pack: string;
  modules: ManifestModule[];
}

export interface FrontendManifest {
  version: number;
  archive: string;
  modules: ManifestModule[];
}

/**
 * An individual layer after we've resolved its filesystem location and
 * (optionally) its npm package name. We keep both because different
 * callers need different shapes: the workspace setup uses `packageName`
 * to write `link:` deps and to reference layers by name in `extends`,
 * while the `prepare` command (run from inside a layer during dev) falls
 * back to absolute paths.
 */
export interface ResolvedLayer {
  path: string;
  packageName?: string;
  priority?: number;
  configKey?: string;
  options?: FrontendModuleOptions;
  authEstablishEndpoints?: string[];
}

// ============================================================================
// Workspace Management
// ============================================================================

/**
 * Get the workspace directory for an arbitrary identity key. The key is
 * normally the canonical backend URL (see `getWorkspaceDir`), but the dev
 * command's autodiscovery mode keys the workspace on the antelope project
 * path instead — the backend port can change between runs (port fallback),
 * and re-keying on the URL would discard node_modules and the manifest
 * cache every time it does.
 */
export function getWorkspaceDirForKey(key: string): string {
  return join(DMS_FRONTEND_HOME, sha256Hex(key));
}

/** Marks a workspace key as a project path rather than a backend URL. */
const PROJECT_KEY_PREFIX = "project:";

/**
 * Workspace key for a project-path-keyed workspace (autodiscovery mode).
 * Prefixed so it can never collide with a canonicalized backend URL.
 */
export function projectWorkspaceKey(projectDir: string): string {
  return `${PROJECT_KEY_PREFIX}${resolve(projectDir)}`;
}

/**
 * The project directory a workspace is keyed on, or undefined when it is
 * keyed on its backend URL like every workspace `build` and `start` create.
 */
export function projectDirFromWorkspaceKey(
  workspaceKey: string | undefined,
): string | undefined {
  return workspaceKey?.startsWith(PROJECT_KEY_PREFIX)
    ? workspaceKey.slice(PROJECT_KEY_PREFIX.length)
    : undefined;
}

/**
 * Get the workspace directory for a given backend URL. Each backend URL
 * gets its own isolated workspace at ~/.antelopejs/dms-frontend/<hash>/ so
 * concurrent projects don't share node_modules or manifest caches.
 */
export function getWorkspaceDir(backendUrl: string): string {
  return getWorkspaceDirForKey(canonicalizeBackendUrl(backendUrl));
}

/**
 * Ensure the workspace directory for the given identity key exists and
 * return its path
 */
export function ensureWorkspace(workspaceKey: string): string {
  const dir = getWorkspaceDirForKey(workspaceKey);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  }
  chmodSync(dir, WORKSPACE_DIR_MODE);
  return dir;
}

export interface WorkspaceEntry {
  dir: string;
  backendUrl: string;
  /**
   * The exact string hashed into the directory name: the canonical backend
   * URL, or `project:<path>` for a workspace `dev` created without `-b`.
   * Reported alongside the URL because those two keys produce two separate
   * workspaces for the same backend, which is otherwise invisible.
   */
  workspaceKey?: string;
}

/**
 * One line naming what a workspace is keyed on, for `clean --all`.
 *
 * A project-keyed workspace names its project directory as well as its
 * backend, because the same backend also has — or will have — a second,
 * URL-keyed workspace built by `build`, and the two are otherwise
 * indistinguishable in a listing of hashed directory names.
 */
export function describeWorkspace(entry: WorkspaceEntry): string {
  const projectDir = projectDirFromWorkspaceKey(entry.workspaceKey);
  return projectDir
    ? `${entry.backendUrl}, keyed on project ${projectDir}`
    : entry.backendUrl;
}

/**
 * List the workspaces this loader owns, with the backend each one is keyed on.
 *
 * A directory under the loader home is only a workspace once
 * `writeWorkspaceMeta` has stamped it, so one without a readable metadata file
 * is foreign (or a half-created directory from an interrupted run) and is
 * skipped with a warning rather than reported as a nameless workspace.
 */
export function listWorkspaces(): WorkspaceEntry[] {
  if (!existsSync(DMS_FRONTEND_HOME)) return [];
  const workspaces: WorkspaceEntry[] = [];
  for (const entry of readdirSync(DMS_FRONTEND_HOME, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(DMS_FRONTEND_HOME, entry.name);
    const meta = readWorkspaceMeta(dir);
    if (meta?.backendUrl === undefined) {
      console.warn(`⚠ Skipping ${dir}: no readable ${WORKSPACE_META_FILE}.`);
      continue;
    }
    workspaces.push({
      dir,
      backendUrl: meta.backendUrl,
      workspaceKey: meta.workspaceKey,
    });
  }
  return workspaces;
}

function readWorkspaceMeta(
  dir: string,
): { backendUrl?: string; workspaceKey?: string } | undefined {
  let meta: unknown;
  try {
    meta = JSON.parse(readFileSync(join(dir, WORKSPACE_META_FILE), "utf-8"));
  } catch {
    return undefined;
  }
  const record = meta as {
    backendUrl?: unknown;
    workspaceKey?: unknown;
  } | null;
  return {
    backendUrl:
      typeof record?.backendUrl === "string" ? record.backendUrl : undefined,
    workspaceKey:
      typeof record?.workspaceKey === "string"
        ? record.workspaceKey
        : undefined,
  };
}

/**
 * The stored backendUrl is the canonical form, not the raw CLI input, and
 * `workspaceKey` is the exact string that was hashed into the directory
 * name (the canonical URL, or `project:<path>` in autodiscovery mode) —
 * so `clean --all` and `listWorkspaces` report exactly what identifies
 * the workspace.
 */
export function writeWorkspaceMeta(
  workspaceDir: string,
  backendUrl: string,
  workspaceKey: string,
): void {
  writeFileSync(
    join(workspaceDir, WORKSPACE_META_FILE),
    JSON.stringify(
      {
        backendUrl: canonicalizeBackendUrl(backendUrl),
        workspaceKey,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

// ============================================================================
// Manifest Fetching
// ============================================================================

const BOOTSTRAP_HEADER = "x-dms-bootstrap";
const UNAUTHORIZED_STATUSES = [401, 403];
export const FRONTEND_MANIFEST_VERSION = 1;

export function bootstrapHeaders(secret?: string): Record<string, string> {
  return secret ? { [BOOTSTRAP_HEADER]: secret } : {};
}

export function isUnauthorized(status: number): boolean {
  return UNAUTHORIZED_STATUSES.includes(status);
}

/**
 * The backend rejected our credential for its layer endpoints.
 *
 * Distinct from a transport failure because it must never fall back to the
 * cached manifest: that cache can still hold the private layer options a
 * previously-authorized run received, and replaying them would defeat the
 * very gate the backend is applying.
 */
