import { CODINGS, stance } from "./contract.mjs";

/** @typedef {import("./inputs.mjs").Case} Case */
/**
 * A promise the current code breaks, as SKILL.md records it: its id, the rule
 * that shows it, and which cases belong to it. The rule is checked without
 * those cases, and must still break on them.
 *
 * @typedef {{ id: string, rule: string, isIn: (current: Case) => boolean }} Finding
 */

/**
 * F1: `acceptedCodings` compares `identity` with `br` and `gzip` alone, then
 * `acceptedVariant` keeps the codings the build wrote a copy of. When the
 * header ranks identity above the copies that exist, but not above a coding
 * that has none, the plain file loses and a coding the header ranks below it
 * goes out.
 *
 * @param {Case} current
 */
function identityLostToMissingCopy({ header, copies }) {
  const { wanted, best, identity, quality } = stance(header, copies);
  if (identity === undefined || wanted.length === 0 || identity <= best) return false;
  return identity <= Math.max(...CODINGS.map((coding) => quality(coding)));
}

/** @type {Finding[]} */
export const FINDINGS = [{ id: "F1", rule: "HighestQualityWins", isIn: identityLostToMissingCopy }];
