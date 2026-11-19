import { journeys as renderingProtocol } from "../rendering-protocol.mjs";
import { journeys as renderingPages } from "../rendering-pages.mjs";
import { journeys as renderingBrowser } from "../rendering-browser.mjs";

export const journeys = [...renderingProtocol, ...renderingPages, ...renderingBrowser];
