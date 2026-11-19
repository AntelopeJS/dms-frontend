import { journeys as owner } from "../routing-owner.mjs";
import { journeys as pages } from "../routing-pages.mjs";
import { journeys as routes } from "../routing-routes.mjs";
import { journeys as rules } from "../routing-rules.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, runJourneys } = byRunner([...routes, ...rules, ...pages, ...owner]);
