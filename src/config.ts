// Constants, the Options bag read from the environment, and the bootstrap
// credential handling.
//
// Split out of common.ts, which stays the barrel every command imports from.
import { createHash, randomBytes } from "node:crypto";

import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Option } from "commander";
import ignore from "ignore";
import {
  DEV_HANDSHAKE_RELATIVE_PATH,
  type DiscoveryOptions,
  discoverBackend,
  readDevBootstrapCredential,
} from "./discovery";

// ============================================================================
// Constants
// ============================================================================

/**
 * Shared AntelopeJS home. Every generated workspace, manifest cache and
 * extracted archive lives under this loader's own subdirectory so the DMS
 * frontend never collides with another AntelopeJS tool's state.
 */
const ANTELOPEJS_HOME = join(homedir(), ".antelopejs");
export const DMS_FRONTEND_HOME = join(ANTELOPEJS_HOME, "dms-frontend");
export const DEPS_HASH_FILE = ".deps-hash";

/**
 * The manifest cache stores the backend's response verbatim, including the
 * private module options it serves to an authenticated caller, so it must not
 * be world-readable under a default umask.
 */
const SECRET_BEARING_FILE_MODE = 0o600;

const TEMP_FILE_SUFFIX = ".tmp";

/**
 * A generated Vite/Inertia workspace holds secret-bearing manifests, frontend
 * module options, and cached source archives. Restricting the directory covers
 * all generated files without having to enumerate each one.
 */
export const WORKSPACE_DIR_MODE = 0o700;

/**
 * Write a file that carries backend secrets, owner-readable only.
 *
 * Goes through a temporary sibling rather than writing in place: a workspace
 * created before this hardening still holds a world-readable file, and
 * `writeFileSync`'s `mode` is ignored for a file that already exists — so
 * writing first and chmod'ing after would publish the secrets to every local
 * reader for the duration of the write, and leave an already-open descriptor
 * readable afterwards.
 */
export function writeSecretBearingFile(file: string, content: string): void {
  const temp = `${file}.${process.pid}${TEMP_FILE_SUFFIX}`;
  writeFileSync(temp, content, { mode: SECRET_BEARING_FILE_MODE });
  chmodSync(temp, SECRET_BEARING_FILE_MODE);
  renameSync(temp, file);
}

/**
 * Static files copied verbatim from `templates/` into the workspace.
 * Each entry is `[sourceName, destName]`: npm strips any `.npmrc` from
 * published tarballs (hardcoded, to prevent token leaks), so we ship the
 * file as `npmrc` in the package and rename it to `.npmrc` on copy.
 */
export const TEMPLATE_FILES: ReadonlyArray<readonly [string, string]> = [
  ["vite.config.ts", "vite.config.ts"],
  ["vite.email.config.ts", "vite.email.config.ts"],
  ["index.html", "index.html"],
  ["main.ts", "main.ts"],
  ["app-runtime.ts", "app-runtime.ts"],
  ["ssr-renderer.ts", "ssr-renderer.ts"],
  ["frontend-module.ts", "frontend-module.ts"],
  ["globals.d.ts", "globals.d.ts"],
  ["compress-assets.mjs", "compress-assets.mjs"],
  ["head-order.mjs", "head-order.mjs"],
  ["email-renderer.ts", "email-renderer.ts"],
  ["email-runtime.ts", "email-runtime.ts"],
  ["email-locales.ts", "email-locales.ts"],
  ["tsconfig.json", "tsconfig.json"],
  ["typecheck-loader.mjs", "typecheck-loader.mjs"],
  ["app-config-stub.mjs", "app-config-stub.mjs"],
  ["DmsDynamicPage.vue", "DmsDynamicPage.vue"],
  ["server.mjs", "server.mjs"],
  ["server", "server"],
  ["npmrc", ".npmrc"],
  ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
] as const;

export const LAYERS_SUBDIR = "frontend-modules";
export const FRONTEND_MODULE_ENTRY = "dms.frontend.ts";

/**
 * Generated file naming the backend endpoints `/auth/establish` may open a
 * session from. Written at the workspace root, next to the module registry,
 * because the generated server reads it at run time with no backend to ask.
 */
export const AUTH_ESTABLISH_FILE = "generated-auth-establish.json";

/**
 * Gitignore-style patterns we never want to copy from a layer source into
 * its workspace materialization. Hardcoded rather than driven by the
 * layer's own `.gitignore` so the behavior is deterministic across
 * third-party layers (some of which legitimately gitignore
 * runtime-relevant files for their own local dev needs).
 *
 * TypeScript configs are excluded because the generated workspace owns its
 * compiler configuration. Generic build and tool caches are also omitted.
 */
export const LAYER_COPY_BLOCKLIST: readonly string[] = [
  "node_modules",
  "dist",
  ".git",
  "coverage",
  ".cache",
  ".turbo",
  "server",
  "**/server",
  "tsconfig.json",
  "tsconfig.*.json",
];

export const layerCopyIgnore = ignore().add([...LAYER_COPY_BLOCKLIST]);

/**
 * Lifecycle scripts pnpm runs automatically during `pnpm install`. Any of
 * these defined on a layer's own `package.json` would fire inside the
 * workspace copy — which is almost always wrong because module-local setup
 * can overwrite or recursively invoke generated workspace preparation.
 * Custom scripts (build, lint, typecheck, ...) are left intact because
 * nothing in the workspace flow invokes them.
 */
export const PNPM_LIFECYCLE_SCRIPTS: readonly string[] = [
  "preinstall",
  "install",
  "postinstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
];

export const TAILWIND_SOURCE_GLOB = "**/*.{vue,ts,tsx,js,jsx,mjs,cjs}";

// ============================================================================
// Shared CLI Options
// ============================================================================

/**
 * Resolve a boolean from an env var ourselves instead of Commander's
 * `.env()`: for argument-less flags Commander treats any non-empty value
 * as true, so `DMS_OFFLINE=false` or `DMS_OFFLINE=0` in a CI script would
 * silently ENABLE offline mode.
 */
function booleanFromEnv(name: string): boolean {
  const value = process.env[name];
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export const Options = {
  backendUrl: new Option(
    "-b, --backend-url <url>",
    "Backend DMS URL (when omitted, dev mode discovers it from the enclosing antelope project's .antelope/dev.json)",
  ).env("DMS_API_BASE_URL"),

  port: new Option("-p, --port <port>", "Port to run on")
    .default("3001")
    .env("PORT"),

  force: new Option("-f, --force", "Force reinstall dependencies"),

  /**
   * Built on access rather than when this module is evaluated: its default
   * reads the environment eagerly, and the CLI loads the project's `.env`
   * into that environment at startup — long after the import graph settles.
   * Reading it at module scope would miss a `DMS_OFFLINE` line in the file.
   */
  get offline(): Option {
    return new Option(
      "--offline",
      "Skip the backend manifest fetch and reuse the last cached manifest (env: DMS_OFFLINE)",
    ).default(booleanFromEnv("DMS_OFFLINE"));
  },

  bootstrapSecret: new Option(
    "--bootstrap-secret <secret>",
    "Credential presented to the backend's layer endpoints (env: DMS_BOOTSTRAP_SECRET, preferred — " +
      "a secret passed on the command line is visible to every process on the machine). In dev it is " +
      "discovered from the antelope project's .antelope/dms-dev.json.",
  ).env("DMS_BOOTSTRAP_SECRET"),
};

/**
 * A credential travels in an HTTP header, so a stray carriage return or
 * non-ASCII byte — routine when the value comes from a mounted secret file —
 * makes `fetch` throw a bare `TypeError: Invalid header value` that names
 * nothing the caller can act on.
 */
const HEADER_SAFE_CREDENTIAL = /^[\x21-\x7e]+$/;

export interface BootstrapDiscoveryOptions extends DiscoveryOptions {
  /** Directory the project walk starts from; defaults to the process cwd */
  cwd?: string;
}

const DEFAULT_CREDENTIAL_SOURCE = "DMS_BOOTSTRAP_SECRET";

/**
 * Normalize a credential, whatever supplied it.
 *
 * A discovered credential goes through this too: the backend publishes its
 * configured `frontend.bootstrapSecret` to the handshake file when one is set, so
 * an operator's malformed config would otherwise reach `fetch` unexamined.
 *
 * @param value Credential as supplied
 * @param source Where it came from, for the error message
 * @returns The trimmed credential, or undefined when none was supplied
 */
export function normalizeBootstrapSecret(
  value: string | undefined,
  source: string = DEFAULT_CREDENTIAL_SOURCE,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!HEADER_SAFE_CREDENTIAL.test(trimmed)) {
    throw new Error(
      "The bootstrap credential contains characters that cannot travel in an HTTP header.\n" +
        `  Check ${source} for a line break or a non-ASCII byte — a secret read from\n` +
        "  a file commonly keeps its trailing newline.",
    );
  }
  return trimmed;
}

export type SessionSecretMode = "dev" | "build" | "start";

/**
 * Resolve the secret used by the generated server. Development gets a fresh
 * in-memory secret when none is configured; persistent commands must be
 * explicit so a deployment cannot silently invalidate sessions on restart.
 */
export function resolveSessionSecret(
  mode: SessionSecretMode,
  value: string | undefined = process.env.DMS_SESSION_SECRET,
): string {
  if (value === undefined && mode === "dev") {
    return randomBytes(32).toString("hex");
  }
  if (value === undefined || value.length < 32) {
    throw new Error(
      "DMS_SESSION_SECRET must contain at least 32 characters; " +
        (mode === "dev"
          ? "set it explicitly or omit it to generate an ephemeral dev secret"
          : "set it explicitly for build and start"),
    );
  }
  return value;
}

/**
 * Pick the credential to present to `backendUrl`.
 *
 * A discovered credential is only ever presented to the backend that
 * published it. The handshake file says nothing about who may receive its
 * contents, so pairing it with whatever `-b` happens to name would send a
 * local instance's secret — the configured `frontend.bootstrapSecret` itself,
 * when one is set — to an arbitrary third-party host. Correlating against the
 * project's own dev registry is what makes the fallback safe, and it reuses
 * `discoverBackend`'s walk so the credential and the backend can never be
 * resolved from two different projects.
 *
 * @param explicit Value from the flag or environment
 * @param backendUrl The backend this credential would be sent to
 * @param options Injectable cwd and pid probe, for tests
 * @returns The credential, or undefined when none applies
 */
export function resolveBootstrapSecret(
  explicit: string | undefined,
  backendUrl: string,
  options: BootstrapDiscoveryOptions = {},
): string | undefined {
  const normalized = normalizeBootstrapSecret(explicit);
  if (normalized) return normalized;

  const result = discoverBackend(options.cwd ?? process.cwd(), options);
  if (result.status !== "found") return undefined;
  if (
    canonicalizeBackendUrl(result.backend.backendUrl) !==
    canonicalizeBackendUrl(backendUrl)
  ) {
    return undefined;
  }
  return normalizeBootstrapSecret(
    readDevBootstrapCredential(result.backend.projectDir, options),
    join(result.backend.projectDir, DEV_HANDSHAKE_RELATIVE_PATH),
  );
}

// ============================================================================
// Types
// ============================================================================

/**
 * Compute a full SHA-256 hex digest for a string. Used to derive unique
 * workspace directories and appIds. A previous version sliced this to
 * 12 chars, but short hashes collide in practice when two backend URLs
 * hash to the same prefix, which would make them share the same
 * client-side appId scope (localStorage, cookies, persisted Pinia state).
 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Canonicalize a backend URL so that equivalent spellings map to the same
 * workspace: `http://localhost:5010/`, `HTTP://LOCALHOST:5010` and
 * `http://127.0.0.1:5010` would otherwise hash to three different
 * directories, each with its own node_modules, manifest cache and appId
 * scope (localStorage, cookies, persisted Pinia state).
 *
 * Normalizations: protocol/hostname lowercased (done by `URL` itself),
 * `localhost`/`[::1]` mapped to `127.0.0.1`, default ports dropped (also
 * `URL` behavior), and the bare trailing slash removed. A string `URL`
 * cannot parse is returned trimmed as-is — hashing a raw string still
 * yields a usable workspace key.
 */
export function canonicalizeBackendUrl(backendUrl: string): string {
  const raw = backendUrl.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  if (url.hostname === "localhost" || url.hostname === "[::1]") {
    url.hostname = "127.0.0.1";
  }

  const out = url.toString();
  if (url.pathname === "/" && !url.search && !url.hash) {
    return out.replace(/\/$/, "");
  }
  return out;
}
