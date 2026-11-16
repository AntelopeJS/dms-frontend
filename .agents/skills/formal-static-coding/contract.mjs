/** @typedef {"br" | "gzip"} Coding */
/** @typedef {Coding | "plain"} Representation */
/** @typedef {"br" | "gzip" | "deflate" | "zstd" | "compress" | "identity" | "*"} Token */
/**
 * One element of an `Accept-Encoding` list as a visitor writes it: the token
 * and how it is cased, the q-value as written (`null` for none), the spacing
 * around the `;` and the `q`, and the separator that follows the element.
 *
 * @typedef {{
 *   token: Token,
 *   written: string,
 *   quality: string | null,
 *   semicolon: string,
 *   weight: "q" | "Q",
 *   separator: string,
 * }} Element
 */
/**
 * The header a visitor sends: a list of elements with one element per token,
 * or no header at all.
 *
 * @typedef {Element[] | null} AcceptEncoding
 */
/** @typedef {{ br: boolean, gzip: boolean }} Copies */

export const CODINGS = /** @type {const} */ (["br", "gzip"]);

/**
 * The header as it goes on the wire.
 *
 * @param {AcceptEncoding} header
 * @returns {string | undefined}
 */
export function render(header) {
  if (header === null) return undefined;
  return header.map((element, index) => {
    const quality = element.quality === null ? "" : `${element.semicolon}${element.weight}=${element.quality}`;
    return `${element.written}${quality}${index === header.length - 1 ? "" : element.separator}`;
  }).join("");
}

/**
 * The q-value RFC 9110 §12.5.3 gives `coding`: its own element's, else the
 * `*` element's, else 0 (not acceptable). An element with no q-value weighs 1.
 *
 * @param {Element[]} header
 * @param {Token} coding
 */
function qualityOf(header, coding) {
  const own = header.find((element) => element.token === coding) ?? header.find((element) => element.token === "*");
  if (!own) return 0;
  return own.quality === null ? 1 : Number(own.quality);
}

/**
 * What the visitor refuses and what it ranks first among the copies the build
 * wrote.
 *
 * `refused` holds the codings of `br` and `gzip` the header gives q=0 or does
 * not name. `best` is the highest q-value of the codings with a copy that
 * the header accepts, `0` when none. `identity` is the q-value of an
 * `identity` element, `undefined` when the header has none: implicit identity
 * is a fallback and never outranks a coding the header accepts (the TSDoc of
 * `acceptedCodings`).
 *
 * @param {AcceptEncoding} header
 * @param {Copies} copies
 */
export function stance(header, copies) {
  const elements = header ?? [];
  const refused = new Set(CODINGS.filter((coding) => qualityOf(elements, coding) === 0));
  const wanted = CODINGS.filter((coding) => copies[coding] && !refused.has(coding));
  const best = Math.max(0, ...wanted.map((coding) => qualityOf(elements, coding)));
  const identity = elements.find((element) => element.token === "identity");
  return {
    refused,
    wanted,
    best,
    identity: identity ? (identity.quality === null ? 1 : Number(identity.quality)) : undefined,
    quality: (/** @type {Coding} */ coding) => qualityOf(elements, coding),
  };
}

/**
 * Every representation the header allows the server to send: a coding with a
 * copy at the highest q-value among those the header accepts, unless an
 * `identity` element ranks the plain file above it, which is then allowed too
 * on a tie. The plain file is the fallback when no copy is acceptable.
 *
 * @param {AcceptEncoding} header
 * @param {Copies} copies
 * @returns {Set<Representation>}
 */
export function allowed(header, copies) {
  const { wanted, best, identity, quality } = stance(header, copies);
  /** @type {Set<Representation>} */
  const answers = new Set();
  if (wanted.length === 0) return answers.add("plain");
  if (identity === undefined || best >= identity) for (const coding of wanted) if (quality(coding) === best) answers.add(coding);
  if (identity !== undefined && identity >= best) answers.add("plain");
  return answers;
}
