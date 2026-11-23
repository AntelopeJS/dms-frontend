import type { DmsLayerAppConfig } from "./frontend-module";

/** Every layer's `app/app.config.ts`, highest precedence first. */
export declare const appConfigs: DmsLayerAppConfig[];

/** Development only: hands `listener` the configs of every hot update. */
export declare function syncAppConfigs(
  listener: (appConfigs: DmsLayerAppConfig[]) => void,
): void;
