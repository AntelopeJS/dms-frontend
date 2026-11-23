import { inject } from "vue";
import type {
  DmsAppConfig,
  PublicRuntimeConfig,
} from "./frontend-runtime/types";

export interface EmailRuntimeConfig {
  public: PublicRuntimeConfig & {
    dms: { clientBaseUrl: string };
  };
}

export function useDmsAppConfig(): DmsAppConfig {
  return inject<DmsAppConfig>("dmsEmailAppConfig", {});
}

export function useDmsRuntimeConfig(): EmailRuntimeConfig {
  return inject<EmailRuntimeConfig>("dmsEmailRuntimeConfig", {
    public: { dms: { clientBaseUrl: process.env.DMS_CLIENT_BASE_URL ?? "" } },
  });
}

export function defineDmsAppConfig<T extends DmsAppConfig>(config: T): T {
  return config;
}
