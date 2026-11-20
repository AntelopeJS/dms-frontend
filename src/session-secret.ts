import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UsageError,
  WORKSPACE_DIR_MODE,
  writeSecretBearingFile,
} from "./config";

/**
 * The command a session secret is resolved for. `dev` keeps the secret it
 * generates in its workspace; `start` keeps none.
 */
export type SessionSecretCommand =
  | { mode: "dev"; workspaceDir: string }
  | { mode: "start" };

const SESSION_SECRET_MIN_LENGTH = 32;

/** The file in a dev workspace that holds the session secret `dev` generated. */
const DEV_SESSION_SECRET_FILE = ".session-secret";

/**
 * Resolve the secret used by the generated server. An explicit value is used
 * as it is. Without one, `dev` reads the secret it generated for the
 * workspace on an earlier run, so a restart keeps sessions open, and `start`
 * refuses to run so a deployment cannot silently invalidate them.
 */
export function resolveSessionSecret(
  command: SessionSecretCommand,
  value: string | undefined = process.env.DMS_SESSION_SECRET,
): string {
  if (value === undefined && command.mode === "dev") {
    return devSessionSecret(command.workspaceDir);
  }
  if (value !== undefined && value.length >= SESSION_SECRET_MIN_LENGTH) {
    return value;
  }
  throw new UsageError({
    title: `DMS_SESSION_SECRET ${describeSessionSecret(value)}`,
    reason:
      command.mode === "dev"
        ? "dev generates a secret only when the variable is not set at all."
        : "start signs sessions with it, so it must stay the same across restarts.",
    fixes: [
      "Create one: openssl rand -hex 32, then set it in the environment or ./.env",
    ],
  });
}

function devSessionSecret(workspaceDir: string): string {
  const file = join(workspaceDir, DEV_SESSION_SECRET_FILE);
  const stored = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (stored.length >= SESSION_SECRET_MIN_LENGTH) return stored;
  const secret = randomBytes(32).toString("hex");
  mkdirSync(workspaceDir, { recursive: true, mode: WORKSPACE_DIR_MODE });
  writeSecretBearingFile(file, secret);
  return secret;
}

function describeSessionSecret(value: string | undefined): string {
  if (value === undefined) return "is not set";
  if (value === "") return "is empty";
  return `is too short: ${value.length} characters, at least ${SESSION_SECRET_MIN_LENGTH} needed`;
}
