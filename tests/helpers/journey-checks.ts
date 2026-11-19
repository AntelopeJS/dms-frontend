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
import type { RunState } from "@antelopejs/dms/e2e/run";
import { isObjectLike, isText } from "./guards";

/** One observation a journey records: what it checked, whether it held, and what it saw. */
interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

/** Anything a journey compares or reports, as the kit serialises it. */
type Observed =
  | string
  | number
  | boolean
  | null
  | undefined
  | Observed[]
  | { [key: string]: Observed };

/** A journey of `e2e/` that opens no browser tab, which `node:test` runs. */
export interface NodeJourney {
  id: string;
  knownFailures?: Readonly<Record<string, string>>;
  run(ctx: JourneyContext): Promise<void>;
}

/** The journeys of one feature module of `e2e/journeys` that one runner runs. */
export interface JourneyFeature {
  feature: string;
  journeys: NodeJourney[];
}

/**
 * Who runs a journey outside Playwright, by the export of its feature module: `cliJourneys` need only the CLI of
 * this checkout, `runJourneys` a run of the kit.
 */
const EXPORT_OF = { cli: "cliJourneys", run: "runJourneys" } as const;

const UNIQUE_BYTES = 3;
const JOURNEYS = resolve(import.meta.dirname, "..", "..", "e2e", "journeys");

class CriticalStep extends Error {}

/**
 * The run of a CLI journey: a scratch run folder, a scratch HOME and this checkout as the renderer. Every field
 * only a run of the kit has throws when read, so a journey that needs the run fails instead of reading nothing.
 */
class CliRunState {
  readonly id = randomBytes(UNIQUE_BYTES).toString("hex");
  readonly dir = mkdtempSync(join(tmpdir(), "dms-frontend-journey-"));
  readonly home = join(this.dir, "home");
  readonly evidence = join(this.dir, "evidence");
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
  throw new Error(`${field} needs a run: the journey is not CLI-only`);
}

/**
 * The journey context of the kit, reduced to what a journey reads without a browser: the run, or a scratch one,
 * checks recorded into numbered step folders under `<evidence>/<journey>/`, and the run's administrator.
 */
export class JourneyContext {
  readonly checks: Check[] = [];
  readonly folder: string;
  private index = 0;

  constructor(
    readonly journey: string,
    readonly state: CliRunState | RunState,
  ) {
    this.folder = join(state.evidence, journey);
  }

  step(label: string): string {
    this.index += 1;
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 60);
    const folder = join(
      this.folder,
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

  /**
   * The e-mail and password of the run's administrator.
   *
   * @throws When the run onboarded no administrator
   */
  adminCredentials(): { email: string; password: string } {
    const admin = this.state.accounts.admin;
    if (admin === undefined)
      throw new Error("the run has no administrator: onboard it first");
    return admin;
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
function isNodeJourney(value: unknown): value is NodeJourney {
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
 * The journeys `runner` runs, from every feature module of `e2e/journeys`, in file order, leaving out the features
 * that have none.
 *
 * @throws When a module's export of them holds something that is not a journey
 */
export async function journeyFeatures(
  runner: keyof typeof EXPORT_OF,
): Promise<JourneyFeature[]> {
  const name = EXPORT_OF[runner];
  const features: JourneyFeature[] = [];
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
    const journeys = entries.filter(isNodeJourney);
    if (journeys.length !== entries.length)
      throw new Error(
        `${file}: ${name} holds an entry without an id or a run function`,
      );
    if (journeys.length > 0)
      features.push({ feature: file.replace(/\.mjs$/, ""), journeys });
  }
  return features;
}

/**
 * Runs a journey on `run`, or on a scratch run of its own when there is none, and judges its checks the way the
 * kit does: a check that fails is an error unless the journey lists it in `knownFailures`, and a listed check that
 * passes is an error too, so a fixed finding is removed from the list.
 *
 * @returns The checks that failed unlisted and the listed ones that passed, then the evidence folder; empty when the journey holds, and then a scratch run is removed
 */
export async function judgeJourney(
  journey: NodeJourney,
  run?: RunState,
): Promise<string[]> {
  const state = run ?? new CliRunState();
  const ctx = new JourneyContext(journey.id, state);
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
  if (problems.length > 0) problems.push(`evidence in ${ctx.folder}`);
  else if (state instanceof CliRunState)
    rmSync(state.dir, { recursive: true, force: true });
  return problems;
}
