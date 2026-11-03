declare const defineDmsAppConfig: typeof import("./frontend-module").defineDmsAppConfig;
declare module "virtual:nuxt-ui-icons" {
  export function init(
    add: (name: string, data: import("@iconify/vue").IconifyIcon) => boolean,
  ): void;
}
