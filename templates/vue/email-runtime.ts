import { inject } from "vue";

export interface EmailRuntimeConfig {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the email app config is the application's own, which a template reads and the runtime does not shape
  public: Record<string, unknown> & {
    dms: { clientBaseUrl: string };
  };
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the email app config is the application's own, which a template reads and the runtime does not shape
export function useDmsAppConfig(): Record<string, unknown> {
  // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- the email app config is the application's own, which a template reads and the runtime does not shape
  return inject<Record<string, unknown>>("dmsEmailAppConfig", {});
}

export function useDmsRuntimeConfig(): EmailRuntimeConfig {
  return inject<EmailRuntimeConfig>("dmsEmailRuntimeConfig", {
    public: { dms: { clientBaseUrl: process.env.DMS_CLIENT_BASE_URL ?? "" } },
  });
}

export function defineDmsAppConfig<T extends Record<string, unknown>>(
  config: T,
): T {
  return config;
}
