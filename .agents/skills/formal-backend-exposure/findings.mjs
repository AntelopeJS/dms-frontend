import { ownerOf } from "./contract.mjs";
import { exposureCase } from "./inputs.mjs";

/** @typedef {import("./inputs.mjs").Case} Case */
/** @typedef {import("./contract.mjs").Owner} Owner */
/** @typedef {import("./contract.mjs").Proxy} Proxy */
/**
 * A promise the current code breaks, as SKILL.md records it: its id, the rule
 * that shows it, the other rules its cases break, and which cases belong to
 * it. Every rule it names is checked without those cases; `rule` must still
 * break on them.
 *
 * @typedef {{ id: string, rule: string, alsoBreaks: string[], isIn: (owner: Owner) => boolean }} Finding
 */
/**
 * A finding the code no longer breaks: its id, its rule, and which cases
 * belong to it. Its cases are still sampled on their own, so `rule` must hold
 * on them; a random sample of every case seldom draws them.
 *
 * @typedef {{ id: string, rule: string, isIn: (owner: Owner) => boolean }} FixedFinding
 */

/**
 * The rank the server sorts proxies by (`compilePathPattern`'s
 * `specificity`).
 *
 * @param {Proxy} proxy
 */
function serverRank(proxy) {
  const literals = proxy.literals.filter((literal) => literal !== null).length;
  return literals * 4 + proxy.literals.length * 2 + (proxy.deep ? 0 : 1);
}

/**
 * The covering proxy the server picks: the highest rank, the first declared
 * among equals.
 *
 * @param {Owner} owner
 */
function serverWinner(owner) {
  return owner.covering.reduce((best, proxy) => (serverRank(proxy) > serverRank(best) ? proxy : best));
}

/** @type {Finding[]} */
export const FINDINGS = [];

/** @type {FixedFinding[]} */
export const FIXED = [
  {
    id: "F1",
    rule: "PublicEndpointsWork",
    isIn: (owner) => owner.kind === "backend" && owner.endpoints.length > 0 && serverWinner(owner).auth === "none",
  },
];

/** @param {Case} current */
const ownerOfCase = (current) => ownerOf(current.deployment, current.visit.method, current.visit.target);

/**
 * The cases a rule is checked on: every case outside the findings that break
 * it.
 *
 * @param {string} rule
 */
export function casesFor(rule) {
  const excluded = FINDINGS.filter((finding) => finding.rule === rule || finding.alsoBreaks.includes(rule));
  return excluded.length ? exposureCase.filter((current) => !excluded.some((finding) => finding.isIn(ownerOfCase(current)))) : exposureCase;
}

/**
 * The cases of a finding, fixed or not.
 *
 * @param {Pick<Finding, "isIn">} finding
 */
export function casesOf(finding) {
  return exposureCase.filter((current) => finding.isIn(ownerOfCase(current)));
}

/**
 * Whether `current` is a case `rule` is checked on.
 *
 * @param {string} rule
 * @param {Case} current
 */
export function isCheckedOn(rule, current) {
  const owner = ownerOfCase(current);
  return !FINDINGS.some((finding) => (finding.rule === rule || finding.alsoBreaks.includes(rule)) && finding.isIn(owner));
}

/**
 * Whether `current` belongs to `finding`, fixed or not.
 *
 * @param {Pick<Finding, "isIn">} finding
 * @param {Case} current
 */
export function belongsTo(finding, current) {
  return finding.isIn(ownerOfCase(current));
}
