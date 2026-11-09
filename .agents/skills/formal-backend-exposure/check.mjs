/**
 * Checks the backend exposure rules of the renderer's frontend server
 * (`templates/vue/server.mjs`) on generated deployments and visits, with
 * fast-check, against the contract of the user docs in `contract.mjs`.
 *
 * With no argument it checks each rule on 200 cases; with `--full`, on 2,000.
 * `--seed <n>` explores another sample. Exits 0 when every rule matches the
 * record in SKILL.md, 1 when a rule changed, and 2 when the harness could not
 * run or the arguments were wrong.
 */
import fc from "fast-check";
import { startServers } from "./drive.mjs";
import { belongsTo, casesFor, casesOf, FINDINGS, FIXED, isCheckedOn } from "./findings.mjs";
import { RULES, seenOf } from "./rules.mjs";

/** @typedef {import("./inputs.mjs").Case} Case */
/** @typedef {import("./rules.mjs").Rule} Rule */

const EXIT = { ok: 0, changed: 1, tool: 2 };
const DEFAULT_SEED = 20_261_105;
const RUNS = { ci: 200, full: 2000 };
const SESSIONS = new Map([
  ["none", "signed out"],
  ["valid", "signed in"],
  ["forged", "a session cookie that does not open"],
  ["foreign", "another instance's session cookie"],
]);

/** A visit failed for a reason outside the rules: a timeout or a closed socket. */
class HarnessError extends Error {}

/** @param {string[]} args */
function parseArgs(args) {
  let seed = DEFAULT_SEED;
  let runs = RUNS.ci;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1] ?? "";
    if (arg === "--full") runs = RUNS.full;
    else if (arg === "--seed" && /^\d+$/.test(next)) {
      seed = Number(next);
      index += 1;
    } else return undefined;
  }
  return { seed, runs };
}

/** @param {Case} current */
function describeCase({ deployment, visit }) {
  const origin = visit.origin === "absent" ? "no Origin" : `Origin ${visit.origin}`;
  const host = visit.host === "own" ? "its own Host" : "Host evil.example";
  const headers = visit.headers.length ? `, headers ${visit.headers.join(" ")}` : "";
  return [
    `  DMS_BACKEND_PROXIES=${JSON.stringify(deployment.proxies)}`,
    `  DMS_PUBLIC_ENDPOINTS=${JSON.stringify(deployment.endpoints)}`,
    `  ${visit.method} ${visit.target} (${host}, ${origin}, ${SESSIONS.get(visit.session)}${headers})`,
  ].join("\n");
}

/**
 * The plainer sessions of each session, so that simplifying never cycles: an
 * odd cookie becomes none or a valid one, a valid one becomes none.
 *
 * @type {Map<import("./inputs.mjs").SessionKind, import("./inputs.mjs").SessionKind[]>}
 */
const PLAINER_SESSIONS = new Map([
  ["forged", ["none", "valid"]],
  ["foreign", ["none", "valid"]],
  ["valid", ["none"]],
  ["none", []],
]);

/**
 * The cases one step simpler than `current`: a declaration or a header fewer,
 * or a plainer session, Origin or Host.
 *
 * @param {Case} current
 * @returns {Case[]}
 */
function simpler({ deployment, visit }) {
  const without = (/** @type {unknown[]} */ list, /** @type {number} */ index) => list.filter((_, at) => at !== index);
  return [
    ...deployment.proxies.map((_, index) => ({ deployment: { ...deployment, proxies: without(deployment.proxies, index) }, visit })),
    ...deployment.endpoints.map((_, index) => ({ deployment: { ...deployment, endpoints: without(deployment.endpoints, index) }, visit })),
    ...visit.headers.map((_, index) => ({ deployment, visit: { ...visit, headers: visit.headers.filter((__, at) => at !== index) } })),
    ...(visit.host === "own" ? [] : [{ deployment, visit: { ...visit, host: /** @type {const} */ ("own") } }]),
    ...(visit.origin === "absent" ? [] : [{ deployment, visit: { ...visit, origin: /** @type {const} */ ("absent") } }]),
    ...(PLAINER_SESSIONS.get(visit.session) ?? []).map((session) => ({ deployment, visit: { ...visit, session } })),
  ];
}

const options = parseArgs(process.argv.slice(2));
if (!options) {
  process.stderr.write("usage: node check.mjs [--full] [--seed <n>]\n");
  process.exit(EXIT.tool);
}
const { seed, runs } = options;
for (const method of /** @type {const} */ (["log", "info", "warn", "error"])) console[method] = () => undefined;
const servers = await startServers();

/**
 * @param {Rule} rule
 * @param {Case} current
 */
async function brokenBy(rule, current) {
  const observation = await servers.visit(current).catch((/** @type {unknown} */ error) => {
    throw new HarnessError(error instanceof Error ? error.message : String(error));
  });
  return rule.broken(seenOf(current, observation));
}

/**
 * Checks `rule` on `cases`. Resolves to the counterexample, shrunk by
 * fast-check and then by dropping what it does not need while it stays in
 * `keeps`, with the sentence that says how it breaks the rule; or
 * `undefined` when the rule holds.
 *
 * @param {Rule} rule
 * @param {fc.Arbitrary<Case>} cases
 * @param {(current: Case) => boolean} keeps
 */
async function counterexample(rule, cases, keeps) {
  const details = await fc.check(
    fc.asyncProperty(cases, async (current) => (await brokenBy(rule, current)) === undefined),
    { seed, numRuns: runs },
  );
  if (details.errorInstance instanceof HarnessError) throw details.errorInstance;
  let [found] = details.counterexample ?? [];
  if (!found) return undefined;
  for (let next = found; next; ) {
    found = next;
    next = undefined;
    for (const candidate of simpler(found)) {
      if (keeps(candidate) && (await brokenBy(rule, candidate)) !== undefined) {
        next = candidate;
        break;
      }
    }
  }
  return { found, why: (await brokenBy(rule, found)) ?? "it broke only while shrinking" };
}

/**
 * The first fixed finding of `rule` whose cases break it again.
 *
 * @param {Rule} rule
 */
async function fixedBreak(rule) {
  for (const fixed of FIXED.filter((entry) => entry.rule === rule.name)) {
    const back = await counterexample(rule, casesOf(fixed), (current) => belongsTo(fixed, current));
    if (back) return { found: back.found, why: `on the cases of the fixed ${fixed.id}, ${back.why}` };
  }
  return undefined;
}

/** @type {string[]} */
const holding = [];
let changed = false;
try {
  for (const fixed of FIXED)
    if (!RULES.some((rule) => rule.name === fixed.rule)) throw new Error(`${fixed.id} names no rule: ${fixed.rule}`);
  for (const rule of RULES) {
    const broken = (await counterexample(rule, casesFor(rule.name), (current) => isCheckedOn(rule.name, current))) ?? (await fixedBreak(rule));
    if (broken) {
      changed = true;
      process.stdout.write(`BROKEN ${rule.name}: ${broken.why}\n${describeCase(broken.found)}\n`);
    } else if (!FINDINGS.some((finding) => finding.rule === rule.name)) holding.push(rule.name);
  }
  for (const finding of FINDINGS) {
    const rule = RULES.find((candidate) => candidate.name === finding.rule);
    if (!rule) throw new Error(`${finding.id} names no rule: ${finding.rule}`);
    const still = await counterexample(rule, casesOf(finding), (current) => belongsTo(finding, current));
    if (still) process.stdout.write(`finding ${rule.name}: ${finding.id}, ${still.why}\n${describeCase(still.found)}\n`);
    else {
      changed = true;
      process.stdout.write(`HOLDS  ${rule.name}: ${finding.id} is gone (${runs} cases)\n`);
    }
  }
} catch (error) {
  process.stdout.write(`harness error: ${error instanceof Error ? error.message : String(error)}\n`);
  servers.close();
  process.exit(EXIT.tool);
}
servers.close();
if (holding.length) process.stdout.write(`holds  ${holding.join(", ")} (${runs} cases each, seed ${seed})\n`);
process.exit(changed ? EXIT.changed : EXIT.ok);
