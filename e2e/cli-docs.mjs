/**
 * Reads the examples of the renderer checkout's own docs, so a journey can hold the product to
 * what a page prints.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FENCE = /```text\n([\s\S]*?)```/g;

/**
 * @param {{ state: { renderer: string } }} ctx The journey
 * @param {string} page A docs page, relative to `docs/`
 * @returns {string} Its text
 */
export function docsPage(ctx, page) {
  return readFileSync(join(ctx.state.renderer, "docs", page), "utf8");
}

/**
 * The output a docs page shows for a command: the text block that starts with `$ <command>`.
 *
 * @param {string} text A docs page
 * @param {string} command The command line, without the prompt
 * @returns {string | undefined} What the block prints after the command, lines joined, trailing space trimmed
 */
export function exampleOutput(text, command) {
  for (const match of text.matchAll(FENCE)) {
    const lines = match[1].replace(/\s+$/, "").split("\n");
    if (lines[0] === `$ ${command}`) return lines.slice(1).join("\n");
  }
  return undefined;
}

/**
 * @param {string} text Output text
 * @returns {string} The text with the release number a docs page was written for replaced by `<version>`
 */
export function maskVersion(text) {
  return text.replace(/ajs dms \d+\.\d+\.\d+/g, "ajs dms <version>");
}

/**
 * The rows of the environment table of the configuration page.
 *
 * @param {string} text The configuration page
 * @returns {{ names: string, description: string }[]} Name cell and description, markup removed
 */
export function environmentRows(text) {
  const start = text.indexOf("<!-- env-reference:start -->");
  const end = text.indexOf("<!-- env-reference:end -->");
  return text
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map((line) => {
      const [names, description] =line.split(/\s\|\s/).map((cell) => cell.replace(/^\|\s*|\s*\|$/g, ""));
      return { names: names.replaceAll("`", ""), description: description.replaceAll("`", "") };
    });
}

/**
 * @param {string} text Wrapped terminal text
 * @returns {string} The text with every run of white space as one space
 */
export function flatten(text) {
  return text.replace(/\s+/g, " ").trim();
}
