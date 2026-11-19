import { journeys as help } from "../cli-help.mjs";
import { journeys as options } from "../cli-options.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, cliJourneys } = byRunner([...help, ...options]);
