import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Journey } from "@antelopejs/dms/e2e/run";
import { isObjectLike, isText } from "./guards";

/** One observation a journey records: what it checked, whether it held, and what it saw. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Anything a journey compares or reports, as `dms-control` serialises it. */
type Observed =
  | string
  | number
  | boolean
  | null
  | undefined
  | Observed[]
  | { [key: string]: Observed };

/** A journey of `e2e/` that needs only the `ajs dms` CLI, fixtures and servers of its own. */
export interface CliJourney {
  id: string;
  knownFailures?: Readonly<Record<string, string>>;
  run(ctx: CliJourneyContext): Promise<void>;
}

/** The CLI journeys of one feature module of `e2e/journeys`. */
export interface CliFeature {
  feature: string;
  journeys: CliJourney[];
}

const UNIQUE_BYTES = 3;
const JOURNEYS = resolve(import.meta.dirname, "..", "..", "e2e", "journeys");

class CriticalStep extends Error {}

/**
 * The run of a CLI journey: a scratch run folder, a scratch HOME and this checkout as the renderer. Every field
 * only a `dms-control` run has throws when read, so a journey that needs the run fails instead of reading nothing.
 */
class CliRunState {
  readonly id = randomBytes(UNIQUE_BYTES).toString("hex");
  readonly dir = mkdtempSync(join(tmpdir(), "dms-frontend-journey-"));
  readonly home = join(this.dir, "home");
  readonly renderer = resolve(import.meta.dirname, "..", "..");

  constructor() {
    mkdirSync(this.home);
  }

  get runPlayground(): never {
    return needsRun("runPlayground");
  }

  get webUrl(): never {
    return needsRun("webUrl");
  }

  get apiUrl(): never {
    return needsRun("apiUrl");
  }

  get secrets(): never {
    return needsRun("secrets");
  }

  get accounts(): never {
    return needsRun("accounts");
  }
}

function needsRun(field: string): never {
  throw new Error(
    `${field} needs a dms-control run: the journey is not CLI-only`,
  );
}

/** The journey context of `dms-control`, reduced to what a journey reads without a playground, a backend or a browser. */
export class CliJourneyContext {
  readonly state = new CliRunState();
  readonly checks: Check[] = [];
  private index = 0;

  constructor(readonly journey: string) {}

  step(label: string): string {
    this.index += 1;
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    const folder = join(
      this.state.dir,
      "evidence",
      `${String(this.index).padStart(2, "0")}-${slug}`,
    );
    mkdirSync(folder, { recursive: true });
    return folder;
  }

  record(
    folder: string,
    checks: Check[],
    options: { critical?: boolean } = {},
  ): boolean {
    writeFileSync(
      join(folder, "checks.json"),
      `${JSON.stringify(checks, null, 2)}\n`,
    );
    this.checks.push(...checks);
    const passed = checks.every((check) => check.pass);
    if (!passed && options.critical) throw new CriticalStep(folder);
    return passed;
  }

  async verify(
    label: string,
    checks: (Check | Promise<Check>)[],
    options: { critical?: boolean } = {},
  ): Promise<boolean> {
    return this.record(
      this.step(label),
      await Promise.all(checks.map((check) => Promise.resolve(check))),
      options,
    );
  }

  equal(name: string, actual: Observed, expected: Observed): Check {
    const [left, right] = [JSON.stringify(actual), JSON.stringify(expected)];
    return {
      name,
      pass: left === right,
      detail: `expected ${right}, got ${left}`,
    };
  }

  holds(name: string, pass: Observed, detail: Observed): Check {
    return {
      name,
      pass: Boolean(pass),
      detail: isText(detail) ? detail : JSON.stringify(detail),
    };
  }

  unique(prefix: string): string {
    return `${prefix} ${randomBytes(UNIQUE_BYTES).toString("hex")}`;
  }
}

/** Whether `value` is a record of non-empty findings, as `knownFailures` maps a check's name to the finding that makes it fail. */
function isFindings(value: unknown): value is Readonly<Record<string, string>> {
  return (
    isObjectLike(value) &&
    Object.values(value).every((finding) => isText(finding) && finding !== "")
  );
}

/** Whether `value` is a journey with an id, its findings and a run function, whose parameters no run-time check can read. */
function isCliJourney(value: unknown): value is CliJourney {
  return (
    isObjectLike(value) &&
    "id" in value &&
    isText(value.id) &&
    "run" in value &&
    typeof value.run === "function" &&
    (!("knownFailures" in value) ||
      value.knownFailures === undefined ||
      isFindings(value.knownFailures))
  );
}

/**
 * The `cliJourneys` of every feature module of `e2e/journeys`, in file order, leaving out the features that have none.
 *
 * @throws When a module's `cliJourneys` holds something that is not a journey
 */
export function cliFeatures(): Promise<CliFeature[]> {
  return exportedJourneys("cliJourneys", isCliJourney);
}

/** Whether `value` is a journey the kit runs: an id, a title, an entry point and a run function, whose parameters no run-time check can read. */
function isRunJourney(value: unknown): value is Journey {
  return (
    isCliJourney(value) &&
    "title" in value &&
    isText(value.title) &&
    "entryPoint" in value &&
    isText(value.entryPoint)
  );
}

/**
 * The `runJourneys` of every feature module of `e2e/journeys`, in file order, leaving out the features that have
 * none: the journeys the kit runs on a run without a browser.
 *
 * @throws When a module's `runJourneys` holds something that is not a journey
 */
export function runFeatures(): Promise<
  {
    feature: string;
    journeys: Journey[];
  }[]
> {
  return exportedJourneys("runJourneys", isRunJourney);
}

async function exportedJourneys<J>(
  name: "cliJourneys" | "runJourneys",
  isJourney: (value: unknown) => value is J,
): Promise<{ feature: string; journeys: J[] }[]> {
  const features: { feature: string; journeys: J[] }[] = [];
  for (const file of readdirSync(JOURNEYS)
    .filter((entry) => entry.endsWith(".mjs"))
    .sort()) {
    const exported: unknown = await import(
      pathToFileURL(join(JOURNEYS, file)).href
    );
    const exports = new Map<string, unknown>(
      isObjectLike(exported) ? Object.entries(exported) : [],
    );
    const listed = exports.get(name) ?? [];
    if (!Array.isArray(listed))
      throw new Error(`${file}: ${name} is not a list`);
    const entries: unknown[] = listed;
    const journeys = entries.filter(isJourney);
    if (journeys.length !== entries.length)
      throw new Error(`${file}: ${name} holds an entry that is not a journey`);
    if (journeys.length > 0)
      features.push({ feature: file.replace(/\.mjs$/, ""), journeys });
  }
  return features;
}

/**
 * Runs a journey and judges its checks the way `dms-control` does: a check that fails is an error unless the
 * journey lists it in `knownFailures`, and a listed check that passes is an error too, so a fixed finding is
 * removed from the list.
 *
 * @returns The checks that failed unlisted and the listed ones that passed, then the evidence folder, kept only then; empty when the journey holds
 */
export async function judgeJourney(journey: CliJourney): Promise<string[]> {
  const ctx = new CliJourneyContext(journey.id);
  const known = journey.knownFailures ?? {};
  try {
    await journey.run(ctx);
  } catch (error) {
    if (!(error instanceof CriticalStep)) throw error;
  }
  const problems = ctx.checks.flatMap((check) => {
    const listed = Object.hasOwn(known, check.name);
    if (!check.pass && !listed) return [`${check.name}: ${check.detail}`];
    if (check.pass && listed)
      return [`${check.name} passes: remove it from knownFailures`];
    return [];
  });
  if (ctx.checks.length === 0) problems.push("the journey recorded no check");
  if (problems.length === 0)
    rmSync(ctx.state.dir, { recursive: true, force: true });
  else problems.push(`evidence in ${ctx.state.dir}`);
  return problems;
}
