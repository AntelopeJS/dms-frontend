import { journeys as kill } from "../verify-source-kill.mjs";
import { journeys as layouts } from "../verify-source-layouts.mjs";
import { journeys as run } from "../verify-source-run.mjs";

export const journeys = [...run, ...layouts, ...kill];
