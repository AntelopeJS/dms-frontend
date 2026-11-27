import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const TABLE = resolve(
  __dirname,
  "..",
  "tests",
  "helpers",
  "journey-seconds.ts",
);
const JOURNEY_LINE = /[✔✖] (\S+ › \S+) \(([\d.]+)ms\)$/;
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[\\d;]*m`, "g");
const USAGE =
  "usage: tsx scripts/journey-seconds.ts <log of pnpm test:journeys>...";

/** Each journey's seconds, read from the spec reporter's lines of `logs`. */
function journeySeconds(logs: readonly string[]): Map<string, number> {
  const seconds = new Map<string, number>();
  for (const log of logs)
    for (const line of log.replace(ESCAPES, "").split("\n")) {
      const [, name, ms] = JOURNEY_LINE.exec(line.trimEnd()) ?? [];
      if (name !== undefined && ms !== undefined)
        seconds.set(name, Math.round(Number(ms) / 100) / 10);
    }
  return seconds;
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error(USAGE);
  process.exit(2);
}
const seconds = journeySeconds(files.map((file) => readFileSync(file, "utf8")));
if (seconds.size === 0) {
  console.error(`no journey lines in ${files.join(", ")}\n${USAGE}`);
  process.exit(1);
}
const rows = [...seconds.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, value]) => `  [${JSON.stringify(name)}, ${value}],`);
writeFileSync(
  TABLE,
  [
    "/** Seconds each journey of `pnpm test:journeys` took on CI, by `<feature> › <id>`; `scripts/journey-seconds.ts` writes it. */",
    "export const JOURNEY_SECONDS: ReadonlyMap<string, number> = new Map([",
    ...rows,
    "]);",
    "",
  ].join("\n"),
);
