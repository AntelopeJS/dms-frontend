import { isString } from "./type-guards.mjs";

const SEGMENT = /^[A-Za-z0-9._~-]+$/;

/**
 * A pattern made usable, or `undefined` when it is malformed.
 *
 * `specificity` orders matching patterns from the least to the most specific:
 * more literal segments first, then a single-segment `*` over `**`.
 *
 * Page path patterns, as the modules' `dms.server.ts` name them: `/x` is the
 * page itself, `/x/*` one segment below it, `/x/**` the page and everything
 * below it. Nothing else: no prefix match inside a segment, no query string.
 */
export function compilePathPattern(pattern) {
  if (!isString(pattern) || !pattern.startsWith("/")) return undefined;
  const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
  const deep = segments.at(-1) === "**";
  const literal = deep ? segments.slice(0, -1) : segments;
  if (
    literal.some(
      (segment) =>
        segment !== "*" &&
        (!SEGMENT.test(segment) || segment === "." || segment === ".."),
    )
  )
    return undefined;
  const body = literal
    .map((segment) =>
      segment === "*" ? "/[^/]+" : `/${segment.replaceAll(".", "\\.")}`,
    )
    .join("");
  const matcher = new RegExp(`^${body}${deep ? "(?:/.*)?" : ""}/?$`);
  const literals = literal.filter((segment) => segment !== "*").length;
  return {
    pattern,
    specificity: literals * 4 + literal.length * 2 + (deep ? 0 : 1),
    test: (pathname) => matcher.test(pathname === "" ? "/" : pathname),
  };
}
