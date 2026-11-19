import { journeys as list } from "../workspace-list.mjs";
import { journeys as prepare } from "../workspace-prepare.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, cliJourneys } = byRunner([...list, ...prepare]);
