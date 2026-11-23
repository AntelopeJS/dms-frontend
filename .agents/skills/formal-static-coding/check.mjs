/**
 * Checks which copy of a built file the frontend server sends for any
 * `Accept-Encoding` header (`templates/vue/server/static-files.mjs`), with
 * fast-check, against the contract of RFC 9110 §12.5.3 in `contract.mjs`.
 *
 * With no argument it checks each rule on 200 cases; with `--full`, on 2,000.
 * `--seed <n>` explores another sample. Exits 0 when every rule matches the
 * record in SKILL.md, 1 when a rule changed, and 2 when the harness could not
 * run or the arguments were wrong.
 *
 * @packageDocumentation
 */
import fc from "fast-check";
import { render } from "./contract.mjs";
import { startServer } from "./drive.mjs";
import { FINDINGS } from "./findings.mjs";
import { staticCase } from "./inputs.mjs";
import { RULES } from "./rules.mjs";

/** @typedef {import("./inputs.mjs").Case} Case */
/** @typedef {import("./rules.mjs").Rule} Rule */

const EXIT = { ok: 0, changed: 1, tool: 2 };
const DEFAULT_SEED = 20_261_116;
const RUNS = { ci: 200, full: 2000 };

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
function describeCase({ copies, header, method }) {
  const written = render(header);
  const held = [copies.br ? ".br" : undefined, copies.gzip ? ".gz" : undefined].filter(Boolean).join(" and ") || "no copy";
  return `  ${method} a built file with ${held}, ${written === undefined ? "no Accept-Encoding header" : `Accept-Encoding: ${JSON.stringify(written)}`}`;
}

const options = parseArgs(process.argv.slice(2));
if (!options) {
  process.stderr.write("usage: node check.mjs [--full] [--seed <n>]\n");
  process.exit(EXIT.tool);
}
const { seed, runs } = options;
const server = await startServer();

/**
 * @param {Rule} rule
 * @param {Case} current
 */
async function brokenBy(rule, current) {
  const observation = await server.visit(current).catch((/** @type {unknown} */ error) => {
    throw new HarnessError(error instanceof Error ? error.message : String(error));
  });
  return rule.broken(current, observation);
}

/**
 * Checks `rule` on the cases `keeps` lets through. Resolves to the
 * counterexample fast-check shrank and the sentence that says how it breaks
 * the rule, or `undefined` when the rule holds.
 *
 * @param {Rule} rule
 * @param {(current: Case) => boolean} keeps
 */
async function counterexample(rule, keeps) {
  const details = await fc.check(
    fc.asyncProperty(staticCase.filter(keeps), async (current) => (await brokenBy(rule, current)) === undefined),
    { seed, numRuns: runs },
  );
  if (details.errorInstance instanceof HarnessError) throw details.errorInstance;
  const [found] = details.counterexample ?? [];
  return found ? { found, why: (await brokenBy(rule, found)) ?? "it broke only while shrinking" } : undefined;
}

/** @type {string[]} */
const holding = [];
let changed = false;
try {
  for (const finding of FINDINGS) if (!RULES.some((rule) => rule.name === finding.rule)) throw new Error(`${finding.id} names no rule: ${finding.rule}`);
  for (const rule of RULES) {
    const recorded = FINDINGS.filter((finding) => finding.rule === rule.name);
    const broken = await counterexample(rule, (current) => !recorded.some((finding) => finding.isIn(current)));
    if (broken) {
      changed = true;
      process.stdout.write(`BROKEN ${rule.name}: ${broken.why}\n${describeCase(broken.found)}\n`);
    } else if (!recorded.length) holding.push(rule.name);
  }
  for (const finding of FINDINGS) {
    const rule = RULES.find((candidate) => candidate.name === finding.rule);
    if (!rule) continue;
    const still = await counterexample(rule, finding.isIn);
    if (still) process.stdout.write(`finding ${rule.name}: ${finding.id}, ${still.why}\n${describeCase(still.found)}\n`);
    else {
      changed = true;
      process.stdout.write(`HOLDS  ${rule.name}: ${finding.id} is gone (${runs} cases)\n`);
    }
  }
} catch (error) {
  process.stdout.write(`harness error: ${error instanceof Error ? error.message : String(error)}\n`);
  await server.close();
  process.exit(EXIT.tool);
}
await server.close();
if (holding.length) process.stdout.write(`holds  ${holding.join(", ")} (${runs} cases each, seed ${seed})\n`);
process.exit(changed ? EXIT.changed : EXIT.ok);
