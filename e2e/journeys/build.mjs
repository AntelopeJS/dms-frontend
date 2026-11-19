import { journeys as dev } from "../build-dev.mjs";
import { journeys as run } from "../build-run.mjs";
import { journeys as start } from "../build-start.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, cliJourneys } = byRunner([...run, ...dev, ...start]);
