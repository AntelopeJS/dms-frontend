import { journeys as all } from "../prepare-types-run.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, cliJourneys } = byRunner(all);
