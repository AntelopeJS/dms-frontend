import { journeys as buildDevLaunch } from "./build-dev-launch.mjs";
import { journeys as buildDevSettings } from "./build-dev-settings.mjs";

export const journeys = [...buildDevLaunch, ...buildDevSettings];
