import fc from "fast-check";

/** @typedef {import("./contract.mjs").AcceptEncoding} AcceptEncoding */
/** @typedef {import("./contract.mjs").Copies} Copies */
/** @typedef {import("./contract.mjs").Element} Element */
/** @typedef {import("./contract.mjs").Token} Token */
/**
 * One request for a built file: the files the build wrote for it and the
 * `Accept-Encoding` header the visitor sends, `null` for no header.
 *
 * @typedef {{ copies: Copies, header: AcceptEncoding, method: "GET" | "HEAD" }} Case
 */

/** @type {Token[]} */
const TOKENS = ["br", "gzip", "br", "gzip", "deflate", "zstd", "compress", "identity", "*"];
/** Every q-value the RFC 9110 grammar allows, at its edges and as spelled in the wild. */
const QUALITIES = ["0", "0.", "0.0", "0.000", "0.001", "0.1", "0.5", "0.50", "0.500", "0.999", "1", "1.", "1.0", "1.000"];
const SEMICOLONS = [";", ";", " ; ", "; ", " ;", ";\t"];
const SEPARATORS = [",", ", ", ", ", " , ", " ,  ", ",,", ", ,", ",\t"];

/**
 * @param {Token} token
 * @returns {fc.Arbitrary<string>}
 */
const writtenAs = (token) => fc.constantFrom(token, token.toUpperCase(), token.replace(/^./, (first) => first.toUpperCase()));

/** @type {fc.Arbitrary<Element>} */
const element = fc.constantFrom(...TOKENS).chain((token) =>
  fc.record({
    token: fc.constant(token),
    written: writtenAs(token),
    quality: fc.option(fc.constantFrom(...QUALITIES), { nil: null, freq: 3 }),
    semicolon: fc.constantFrom(...SEMICOLONS),
    weight: fc.constantFrom(/** @type {const} */ ("q"), /** @type {const} */ ("Q")),
    separator: fc.constantFrom(...SEPARATORS),
  }),
);

/** @type {fc.Arbitrary<AcceptEncoding>} */
const acceptEncoding = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  { weight: 12, arbitrary: fc.uniqueArray(element, { selector: (candidate) => candidate.token, minLength: 1, maxLength: 5 }) },
);

/** @type {fc.Arbitrary<Case>} */
export const staticCase = fc.record({
  copies: fc.record({ br: fc.boolean(), gzip: fc.boolean() }),
  header: acceptEncoding,
  method: fc.constantFrom(/** @type {const} */ ("GET"), /** @type {const} */ ("HEAD")),
});
