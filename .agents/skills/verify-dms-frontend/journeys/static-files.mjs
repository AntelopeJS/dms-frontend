import { journeys as documents } from "../static-files-document.mjs";
import { journeys as dev } from "../static-files-dev.mjs";
import { journeys as build } from "../static-files-build.mjs";
import { qualityJourneys, journeys as serve } from "../static-files-serve.mjs";
import { journeys as start } from "../static-files-start.mjs";

export const journeys = [...serve, ...qualityJourneys, ...start, ...build, ...dev, ...documents];
