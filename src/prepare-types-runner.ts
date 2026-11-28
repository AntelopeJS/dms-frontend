/**
 * Writes the type-check configuration and auto-import declarations of
 * unpublished frontend packages to a directory that outlives the run.
 * Started by `ajs dms prepare-types`, it sends its result over IPC for the
 * CLI to report.
 *
 * @packageDocumentation
 */
import { resolve } from "node:path";
import { getProcessTasks, isVerboseRun, pluralize } from "@antelopejs/core/cli";
import { createPathMapper } from "./child-output";
import { assertLayersSupportRenderer, installDeps } from "./common";
import { writeHeader } from "./output";
import {
  assertOutsideSources,
  PREPARE_TYPES_OUT_VARIABLE,
  publishStaging,
  resetStaging,
  runInputs,
  writeRelocatedTypes,
} from "./prepare-types-output";
import { emitVueDeclarations } from "./prepare-types-declarations";
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
  assertOutsideSources(out, runInputs(layers, options.localPackages));
  const staging = resetStaging(out);
  const isVerbose = isVerboseRun();
  const context: VerificationContext = {
    workspace: staging,
    isVerbose,
    mapLine: createPathMapper(staging, layers),
    warnings: new ViteWarnings(),
    env: { ...process.env, [VITE_LOG_LEVEL_VARIABLE]: viteLogLevel(isVerbose) },
  };
  const tasks = getProcessTasks();
  await tasks.run(
    `Materializing ${pluralize(layers.length, "module")}`,
    async () => materializeWorkspace(staging, layers, options.localPackages),
    { done: `Materialized ${pluralize(layers.length, "module")}` },
  );
  await installDeps(staging, context.mapLine, ["--ignore-scripts"]);
  await generateTypeDeclarations(context);
  const writeTsconfig = await tasks.run(
    "Pointing the types at the sources",
    async () => writeRelocatedTypes(staging, layers),
    { done: "Pointed the types at the sources" },
  );
  await tasks.run(
    "Declaring the .vue files",
    async () => emitVueDeclarations(context, layers, writeTsconfig),
    { done: "Declared the .vue files" },
  );
  publishStaging(staging, out);
  return {
    ok: true,
    modules: layers.length,
    out,
    sources: layerTable(out, layers).map(({ source }) => source),
  };
}

startSourceRunner(prepareTypes, reportPreparation);
