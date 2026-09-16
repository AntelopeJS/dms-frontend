import { inject } from "vue";

export interface EmailRuntimeConfig {
  public: Record<string, unknown> & {
    dms: { clientBaseUrl: string };
  };
}

export function useDmsAppConfig(): Record<string, unknown> {
  return inject<Record<string, unknown>>("dmsEmailAppConfig", {});
}

export function useDmsRuntimeConfig(): EmailRuntimeConfig {
  return inject<EmailRuntimeConfig>("dmsEmailRuntimeConfig", {
    public: { dms: { clientBaseUrl: process.env.DMS_CLIENT_BASE_URL ?? "" } },
  });
}

export function defineAppConfig<T extends Record<string, unknown>>(
  config: T,
): T {
  return config;
}
