// Secrets the generated server reads from its environment, and where the
// DMS backend publishes them in the frontend manifest.
//
// The backend serves these values to the renderer as a module's
// `privateOptions`; the generated server only ever reads environment
// variables, so `dev` and `start` hand each value over under the variable
// named here. The table is closed on purpose: modules cannot add entries, so
// a manifest can only ever fill the variables listed below.

import { getProcessUi, type Ui } from "@antelopejs/core/cli";
import type { FrontendModuleValue, ManifestModule } from "./workspace";

export const MANIFEST_SECRET_ENV = {
  DMS_HTML_RENDER_SECRET: ["htmlRender", "serviceSecret"],
  DMS_OAUTH_RELAY_SECRET: ["oauth", "relaySecret"],
} as const;

export type ManifestSecretName = keyof typeof MANIFEST_SECRET_ENV;

const SECRET_NAMES = Object.keys(MANIFEST_SECRET_ENV) as ManifestSecretName[];

/** What the generated server does when a secret reaches it unset. */
const UNSET_CONSEQUENCE: Record<ManifestSecretName, string> = {
  DMS_HTML_RENDER_SECRET: "e-mail renders will be refused",
  DMS_OAUTH_RELAY_SECRET: "OAuth sign-in will be refused by the backend",
};

/** A secret found in the manifest, with the module that published it. */
interface PublishedSecret {
  value: string;
  module: string;
}

/**
 * Modules that published a different value for a secret than the one used.
 * Only module names are kept: a conflict is reported, never its values.
 */
export interface ManifestSecretConflict {
  name: ManifestSecretName;
  used: string;
  ignored: string[];
}

export interface ManifestSecrets {
  published: Partial<Record<ManifestSecretName, PublishedSecret>>;
  conflicts: ManifestSecretConflict[];
}

/** Where the value the server receives comes from. */
export type ManifestSecretSource = "env" | "manifest" | "not set";

export interface ResolvedManifestSecrets {
  /** Variables to add to the server's environment (unset ones are omitted) */
  env: Partial<Record<ManifestSecretName, string>>;
  sources: Record<ManifestSecretName, ManifestSecretSource>;
  /** Conflicts that matter: the environment did not settle the value */
  conflicts: ManifestSecretConflict[];
}

function readPath(
  options: FrontendModuleValue | undefined,
  path: readonly string[],
): FrontendModuleValue | undefined {
  let value = options;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    value = value[key];
  }
  return value;
}

/** Manifest priority order: descending priority, manifest order on ties. */
function byPriority(modules: readonly ManifestModule[]): ManifestModule[] {
  return [...modules].sort((a, b) => b.priority - a.priority);
}

/**
 * The secrets of the table the manifest publishes. For each one, the first
 * module in priority order carrying a non-empty string wins; a later module
 * publishing a different non-empty value is recorded as a conflict.
 */
export function collectManifestSecrets(
  modules: readonly ManifestModule[],
): ManifestSecrets {
  const published: ManifestSecrets["published"] = {};
  const conflicts: ManifestSecretConflict[] = [];
  const ordered = byPriority(modules);
  for (const name of SECRET_NAMES) {
    const ignored: string[] = [];
    for (const module of ordered) {
      const value = readPath(module.privateOptions, MANIFEST_SECRET_ENV[name]);
      if (typeof value !== "string" || value === "") continue;
      const first = published[name];
      if (!first) published[name] = { value, module: module.name };
      else if (first.value !== value) ignored.push(module.name);
    }
    const used = published[name];
    if (used && ignored.length)
      conflicts.push({ name, used: used.module, ignored });
  }
  return { published, conflicts };
}

/**
 * The values the generated server receives. A variable set explicitly in the
 * environment (or the project's `.env`, loaded into it at startup) always
 * wins over the manifest.
 */
export function resolveManifestSecrets(
  secrets: ManifestSecrets,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedManifestSecrets {
  const resolved: ResolvedManifestSecrets = {
    env: {},
    sources: {} as ResolvedManifestSecrets["sources"],
    conflicts: [],
  };
  for (const name of SECRET_NAMES) {
    const explicit = env[name];
    const published = secrets.published[name];
    if (explicit) {
      resolved.env[name] = explicit;
      resolved.sources[name] = "env";
    } else if (published) {
      resolved.env[name] = published.value;
      resolved.sources[name] = "manifest";
    } else {
      resolved.sources[name] = "not set";
    }
  }
  resolved.conflicts = secrets.conflicts.filter(
    (conflict) => resolved.sources[conflict.name] === "manifest",
  );
  return resolved;
}

/** One warning line per conflicting secret, naming modules only. */
export function formatSecretConflicts(
  conflicts: readonly ManifestSecretConflict[],
): string[] {
  return conflicts.map(
    ({ name, used, ignored }) =>
      `${name}: ${ignored.join(", ")} publish${ignored.length === 1 ? "es" : ""} a different value than ${used}; using ${used}'s`,
  );
}

const SOURCE_LABELS: Record<
  Exclude<ManifestSecretSource, "not set">,
  string
> = {
  env: "the environment",
  manifest: "the manifest",
};

/**
 * Where the secrets the server receives come from, never their values:
 * `DMS_HTML_RENDER_SECRET, DMS_OAUTH_RELAY_SECRET from the manifest`.
 * `manifestLabel` names the manifest the command read (`start` reads the one
 * cached at build time). Undefined when none is set.
 */
export function describeSecretSources(
  sources: ResolvedManifestSecrets["sources"],
  manifestLabel = SOURCE_LABELS.manifest,
): string | undefined {
  const labels = { ...SOURCE_LABELS, manifest: manifestLabel };
  const groups = (["env", "manifest"] as const)
    .map((source) => ({
      names: SECRET_NAMES.filter((name) => sources[name] === source),
      label: labels[source],
    }))
    .filter(({ names }) => names.length > 0)
    .map(({ names, label }) => `${names.join(", ")} from ${label}`);
  return groups.length > 0 ? groups.join("; ") : undefined;
}

/**
 * Warns about the conflicts, and about each secret the server runs without,
 * with what stops working: the server starts, degraded. `fix` says how to
 * provide them.
 */
export function reportManifestSecrets(
  resolved: ResolvedManifestSecrets,
  fix: (count: number) => string,
  ui: Ui = getProcessUi(),
): void {
  for (const line of formatSecretConflicts(resolved.conflicts))
    ui.message("warn", line);
  const unset = SECRET_NAMES.filter(
    (name) => resolved.sources[name] === "not set",
  );
  unset.forEach((name, index) => {
    const isLast = index === unset.length - 1;
    ui.message("warn", `${name} is not set: ${UNSET_CONSEQUENCE[name]}`, {
      details: isLast ? [`${ui.symbols.levels.hint} ${fix(unset.length)}`] : [],
    });
  });
}
