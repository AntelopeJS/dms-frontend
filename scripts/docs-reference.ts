// Writes the environment-variable table of the configuration page from the
// list `ajs dms help environment` prints, so the two never disagree.
// `--check` compares instead of writing, and fails when the page is stale.

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { ENVIRONMENT_VARIABLES } from "../src/help";

const PAGE = resolve(__dirname, "..", "docs", "4.configuration.md");
const START_MARKER = "<!-- env-reference:start -->";
const END_MARKER = "<!-- env-reference:end -->";
const CHECK_FLAG = "--check";
const NAME_SEPARATOR = ", ";
const FAILURE_EXIT_CODE = 1;

/** Command-line flags, absolute paths and `{ … }` shapes, set as code. */
const CODE_PATTERN =
  /(\{[^}]*\}|(?<![\w/])--?[a-z][\w-]*|(?<![\w.])\/[\w/.*-]+)/g;

function asCode(text: string): string {
  return text.replace(CODE_PATTERN, (match) => `\`${match}\``);
}

function formatNames(names: string): string {
  return names
    .split(NAME_SEPARATOR)
    .map((name) => `\`${name}\``)
    .join(NAME_SEPARATOR);
}

/** The table, between its markers, as the page holds it. */
function formatEnvironmentTable(): string {
  const rows = ENVIRONMENT_VARIABLES.map(
    ([names, description]) =>
      `| ${formatNames(names)} | ${asCode(description).replaceAll("|", "\\|")} |`,
  );
  return [
    START_MARKER,
    "",
    "| Variable | What it sets |",
    "| --- | --- |",
    ...rows,
    "",
    END_MARKER,
  ].join("\n");
}

function replaceTable(page: string): string {
  const start = page.indexOf(START_MARKER);
  const end = page.indexOf(END_MARKER);
  if (start === -1 || end < start) {
    throw new Error(
      `${relative(process.cwd(), PAGE)} has no ${START_MARKER} … ${END_MARKER} block`,
    );
  }
  return (
    page.slice(0, start) +
    formatEnvironmentTable() +
    page.slice(end + END_MARKER.length)
  );
}

function main(): void {
  const page = readFileSync(PAGE, "utf8");
  const updated = replaceTable(page);
  const shown = relative(process.cwd(), PAGE);
  if (!process.argv.includes(CHECK_FLAG)) {
    writeFileSync(PAGE, updated);
    console.error(`Wrote the environment table of ${shown}`);
    return;
  }
  if (updated !== page) {
    console.error(
      `The environment table of ${shown} is stale: run pnpm docs:reference`,
    );
    process.exitCode = FAILURE_EXIT_CODE;
  }
}

main();
