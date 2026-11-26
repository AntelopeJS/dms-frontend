import * as assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TEMPLATE_PACKAGE = join(
  __dirname,
  "..",
  "..",
  "templates",
  "vue",
  "package.json",
);

/**
 * The arguments the Vue template's package script `name` passes to `vite`.
 */
export function templateViteArguments(name: string): string[] {
  const match = new RegExp(`"${name}": "vite ([^"]*)"`).exec(
    readFileSync(TEMPLATE_PACKAGE, "utf8"),
  );
  assert.ok(match?.[1], `${name} runs vite`);
  return match[1].split(" ");
}
