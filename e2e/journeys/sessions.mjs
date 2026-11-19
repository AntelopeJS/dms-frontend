import { journeys as cookie } from "../sessions-cookie.mjs";
import { journeys as establish } from "../sessions-establish.mjs";
import { journeys as language } from "../sessions-language.mjs";
import { journeys as security } from "../sessions-security.mjs";
import { journeys as hooks } from "../sessions-hooks.mjs";
import { journeys as browser } from "../sessions-browser.mjs";
import { byRunner } from "../standalone.mjs";

export const { journeys, runJourneys } = byRunner([...cookie, ...hooks, ...establish, ...language, ...security, ...browser]);
