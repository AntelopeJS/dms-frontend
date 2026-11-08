import { isString } from "./type-guards.mjs";

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/** The forms a path pattern takes, as the warnings name them. */
export const PATH_PATTERN_FORMS = "/x, /x/* or /x/**";

/**
 * The wildcard a pattern may end with: what it matches below the literal
 * segments, and how it ranks against a pattern with the same literals.
 */
const TAILS = new Map([
  ["*", { matcher: "/[^/]+", rank: 3 }],
  ["**", { matcher: "(?:/.*)?", rank: 0 }],
]);
const NO_TAIL = { matcher: "", rank: 1 };

/**
 * @typedef {object} CompiledPathPattern
 * @property {string} pattern The pattern as declared
 * @property {number} specificity Orders patterns from the least to the most specific
 * @property {(pathname: string) => boolean} test Whether the pattern covers `pathname`
 */

/**
 * A pattern made usable, or `undefined` when it is malformed.
 *
 * `specificity` orders matching patterns from the least to the most specific:
 * more literal segments first, then a single-segment `*` over `**`.
 *
 * Page path patterns, as the modules' `dms.server.ts` name them: `/x` is the
 * page itself, `/x/*` one segment below it, `/x/**` the page and everything
 * below it. Nothing else: a wildcard only as the last segment, no prefix
 * match inside a segment, no query string.
 *
 * @param {unknown} pattern
 * @returns {CompiledPathPattern | undefined}
 */
export function compilePathPattern(pattern) {
  if (!isString(pattern) || !pattern.startsWith("/")) return undefined;
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
  const last = TAILS.get(segments.at(-1) ?? "");
  const literal = last ? segments.slice(0, -1) : segments;
  if (
    literal.some(
      (segment) =>
        !SEGMENT.test(segment) || segment === "." || segment === "..",
    )
  )
    return undefined;
  const tail = last ?? NO_TAIL;
  const body = literal
    .map((segment) => `/${segment.replaceAll(".", "\\.")}`)
    .join("");
  const matcher = new RegExp(`^${body}${tail.matcher}/?$`);
  return {
    pattern,
    specificity: literal.length * 6 + tail.rank,
    test: (pathname) => matcher.test(pathname === "" ? "/" : pathname),
  };
}
