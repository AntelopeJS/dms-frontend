import { allowed, stance } from "./contract.mjs";

/** @typedef {import("./contract.mjs").Representation} Representation */
/** @typedef {import("./drive.mjs").Observation} Observation */
/** @typedef {import("./inputs.mjs").Case} Case */
/**
 * A rule: its name, and a function that answers the sentence that says how
 * `observation` breaks it for `current`, or `undefined` when it holds.
 *
 * @typedef {{ name: string, broken: (current: Case, observation: Observation) => string | undefined }} Rule
 */

/**
 * The representation a visit got, by its `Content-Encoding`: `other` for a
 * coding the server has no copy in.
 *
 * @param {Observation} observation
 * @returns {Representation | "other"}
 */
function sentCoding({ encoding }) {
  if (encoding === undefined) return "plain";
  return encoding === "br" || encoding === "gzip" ? encoding : "other";
}

/** @type {Rule[]} */
export const RULES = [
  {
    name: "NoRefusedCoding",
    broken: (current, observation) => {
      const coding = sentCoding(observation);
      if (coding !== "br" && coding !== "gzip") return undefined;
      return stance(current.header, current.copies).refused.has(coding) ? `the answer is ${coding}, which the header refuses with q=0 or does not name` : undefined;
    },
  },
  {
    name: "HighestQualityWins",
    broken: (current, observation) => {
      const coding = sentCoding(observation);
      /** @type {Set<string>} */
      const answers = allowed(current.header, current.copies);
      if (answers.has(coding)) return undefined;
      return `the answer is ${coding}, the header ranks ${[...answers].join(" or ")} first`;
    },
  },
  {
    name: "BodyMatchesEncoding",
    broken: (current, observation) => {
      if (observation.status !== 200) return `the status is ${observation.status}, not 200`;
      if (current.method === "HEAD") return undefined;
      const coding = sentCoding(observation);
      return observation.body === coding ? undefined : `the Content-Encoding says ${coding}, the body is the ${observation.body ?? "unknown"} copy`;
    },
  },
];
