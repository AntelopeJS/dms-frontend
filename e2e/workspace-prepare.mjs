import { journeys as workspacePrepareOutput } from "./workspace-prepare-output.mjs";
import { journeys as workspacePrepareCases } from "./workspace-prepare-cases.mjs";

export const journeys = [...workspacePrepareOutput, ...workspacePrepareCases];
