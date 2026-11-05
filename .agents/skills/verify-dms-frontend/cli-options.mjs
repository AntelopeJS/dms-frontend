import { journeys as cliOptionsFlags } from "./cli-options-flags.mjs";
import { journeys as cliOptionsEnvironment } from "./cli-options-environment.mjs";

export const journeys = [...cliOptionsFlags, ...cliOptionsEnvironment];
