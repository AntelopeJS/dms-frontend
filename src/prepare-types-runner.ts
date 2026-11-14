import { resolve } from "node:path";
import { getProcessTasks, isVerboseRun, pluralize } from "@antelopejs/core/cli";
import { createPathMapper } from "./child-output";
import { assertLayersSupportRenderer, installDeps } from "./common";
import { writeHeader } from "./output";
import {
  assertOutsideSources,
  PREPARE_TYPES_OUT_VARIABLE,
  resetOutput,
  writeRelocatedTypes,
} from "./prepare-types-output";
import { layerTable } from "./prepare-types-relocate";
import {
  type PreparationResult,
  reportPreparation,
} from "./prepare-types-result";
import { startSourceRunner } from "./source-runner";
import {
  generateTypeDeclarations,
  type VerificationContext,
} from "./verify-source-build";
import { materializeWorkspace } from "./verify-source-workspace";
import { readSourceOptions, readSources } from "./verify-source-sources";
import {
  VITE_LOG_LEVEL_VARIABLE,
  viteLogLevel,
  ViteWarnings,
} from "./vite-output";

async function prepareTypes(): Promise<PreparationResult> {
  const options = readSourceOptions();
  const out = resolve(process.env[PREPARE_TYPES_OUT_VARIABLE] ?? "");
  const { layers } = readSources(options);
  writeHeader("prepare-types", [pluralize(layers.length, "module")]);
  assertLayersSupportRenderer(layers);
  assertOutsideSources(out, layerTable(out, layers));
  resetOutput(out);
  const isVerbose = isVerboseRun();
  const context: VerificationContext = {
    workspace: out,
    isVerbose,
    mapLine: createPathMapper(out, layers),
    warnings: new ViteWarnings(),
    env: { ...process.env, [VITE_LOG_LEVEL_VARIABLE]: viteLogLevel(isVerbose) },
  };
  const tasks = getProcessTasks();
  await tasks.run(
    `Materializing ${pluralize(layers.length, "module")}`,
    async () => materializeWorkspace(out, layers, options.localPackages),
    { done: `Materialized ${pluralize(layers.length, "module")}` },
  );
  await installDeps(out, context.mapLine, ["--ignore-scripts"]);
  await generateTypeDeclarations(context);
  await tasks.run(
    "Pointing the types at the sources",
    async () => writeRelocatedTypes(out, layers),
    { done: "Pointed the types at the sources" },
  );
  return {
    ok: true,
    modules: layers.length,
    out,
    sources: layerTable(out, layers).map(({ source }) => source),
  };
}

/**
 * Writes the type-check configuration and auto-import declarations of
 * unpublished frontend packages to a directory that outlives the run.
 * Started by `ajs dms prepare-types`, it sends its result over IPC for the
 * CLI to report.
 */
startSourceRunner(prepareTypes, reportPreparation);
