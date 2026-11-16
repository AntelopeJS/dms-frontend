import { journeys as owner } from "../routing-owner.mjs";
import { journeys as pages } from "../routing-pages.mjs";
import { journeys as routes } from "../routing-routes.mjs";
import { journeys as rules } from "../routing-rules.mjs";

export const journeys = [...routes, ...rules, ...pages, ...owner];
