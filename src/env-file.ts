// Loading the invoking project's `.env` files into the process environment.
//
// The CLI reads its whole configuration from environment variables —
// `DMS_API_BASE_URL`, `DMS_BOOTSTRAP_SECRET`, `DMS_SESSION_SECRET`, `PORT`,
// `DMS_OFFLINE`, … — and passes `process.env` on to the workspace build and to
// the generated server. A project that keeps those values in a `.env` file
// (as the DMS project templates suggest) would otherwise have to export them
// by hand before every `ajs dms` invocation.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/**
 * Files read at startup, in decreasing precedence.
 *
 * `.env.local` before `.env` is the convention every Vite-based toolchain
 * uses, and the generated workspace is a Vite application: `.env` is the
 * committed, shared baseline and `.env.local` the gitignored per-machine
 * override.
 */
export const ENV_FILE_NAMES = [".env.local", ".env"] as const;

export interface LoadProjectEnvOptions {
  /** Directory the files are read from; defaults to the process cwd. */
  cwd?: string;
  /** Environment to populate; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Reporter for an unreadable file; defaults to a stderr warning. */
  onWarning?: (message: string) => void;
}

/**
 * Load `<cwd>/.env.local` and `<cwd>/.env` into `env`.
 *
 * A variable already present in `env` is never overwritten, so the real
 * environment always wins over a file and `.env.local` always wins over
 * `.env`. That ordering is what makes the files safe to load unconditionally:
 * a CI job, a container, or a one-off `DMS_API_BASE_URL=… ajs dms build` keeps
 * the value the operator chose even when a stale `.env` sits in the checkout.
 *
 * Only the current working directory is consulted — never a parent, and never
 * the generated workspace under `~/.antelopejs/dms-frontend`. The workspace is
 * this tool's own output, shared between projects, and is handed its
 * environment explicitly by the command that spawns it; letting it pick up a
 * `.env` of its own would make a build depend on a file no user wrote.
 *
 * A missing file is not an error. An unreadable or malformed one is reported
 * and skipped rather than aborting the command, because the CLI may well not
 * need anything the file holds.
 *
 * @param options Injectable cwd, target environment and warning sink
 * @returns The absolute paths of the files that were read, in the order read
 */
export function loadProjectEnv(options: LoadProjectEnvOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const onWarning =
    options.onWarning ?? ((message: string) => console.warn(message));

  const loaded: string[] = [];
  for (const name of ENV_FILE_NAMES) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;

    let parsed: NodeJS.Dict<string>;
    try {
      parsed = parseEnv(readFileSync(file, "utf-8"));
    } catch (err: any) {
      onWarning(`⚠ Ignoring ${file}: ${err?.message ?? err}`);
      continue;
    }

    for (const [key, value] of Object.entries(parsed)) {
      if (value !== undefined && env[key] === undefined) env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}
