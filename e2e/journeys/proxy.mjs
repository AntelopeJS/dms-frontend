import { journeys as access } from "../proxy-access.mjs";
import { journeys as answers } from "../proxy-answers.mjs";
import { journeys as declarations } from "../proxy-declarations.mjs";
import { journeys as limits } from "../proxy-limits.mjs";
import { iconJourneys, journeys as redirects } from "../proxy-redirects.mjs";
import { journeys as offline } from "../proxy-offline.mjs";
import { journeys as patterns } from "../proxy-patterns.mjs";
import { journeys as recovery } from "../proxy-recovery.mjs";
import { journeys as relay } from "../proxy-relay.mjs";
import { journeys as streams } from "../proxy-streams.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, runJourneys } = byRunner([...relay, ...access, ...limits, ...redirects, ...iconJourneys, ...answers, ...streams, ...declarations, ...offline, ...recovery, ...patterns]);
