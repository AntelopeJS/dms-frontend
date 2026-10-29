import { CLI_SURFACE_CHECKS } from "./source-checks/cli-surface";
import { DYNAMIC_IMPORT_CHECKS } from "./source-checks/dynamic-imports";
import type { SourceCheck } from "./source-checks/repository";
import { TEMPLATE_FILE_CHECKS } from "./source-checks/template-files";
import { TEMPLATE_SOURCE_CHECKS } from "./source-checks/template-sources";
import { WORKSPACE_PACKAGE_CHECKS } from "./source-checks/workspace-package";

const FAILURE_EXIT_CODE = 1;

const CHECKS: SourceCheck[] = [
  ...TEMPLATE_SOURCE_CHECKS,
  ...WORKSPACE_PACKAGE_CHECKS,
  ...TEMPLATE_FILE_CHECKS,
  ...DYNAMIC_IMPORT_CHECKS,
  ...CLI_SURFACE_CHECKS,
];

async function main(): Promise<void> {
  const failures: string[] = [];
  for (const check of CHECKS)
    for (const problem of await check.run())
      failures.push(`${check.name}: ${problem}`);
  if (failures.length === 0) return;
  process.stderr.write(`${failures.join("\n")}\n`);
  process.exitCode = FAILURE_EXIT_CODE;
}

void main();
