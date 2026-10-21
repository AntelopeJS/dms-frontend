import { registerHooks } from "node:module";

const APP_CONFIG_IMPORT = "#build/app.config";
const APP_CONFIG_URL = new URL("./app-config-stub.mjs", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === APP_CONFIG_IMPORT) {
      return { url: APP_CONFIG_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
