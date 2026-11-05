import { journeys as dev } from "../build-dev.mjs";
import { journeys as run } from "../build-run.mjs";
import { journeys as start } from "../build-start.mjs";

export const journeys = [...run, ...dev, ...start];
