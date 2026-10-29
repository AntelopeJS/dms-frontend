import { router } from "@inertiajs/vue3";
import { createSSRApp, createRenderer } from "vue";
import {
  createDmsFrontendRuntime,
  provideDmsFrontendRuntime,
  setupFrontendModules,
  type DmsMiddleware,
} from "../../templates/vue/frontend-module.ts";

/**
 * Records every navigation Inertia is asked for: a server visit (a request)
 * or a client-side `push`/`replace` (none). Each one finishes at once.
 */
export interface RecordedVisit {
  kind: "server" | "push" | "replace";
  url: string;
  preserveState?: unknown;
  preserveScroll?: unknown;
}

export function recordVisits(context) {
  const visits: RecordedVisit[] = [];
  context.mock.method(router, "visit", (url, options = {}) => {
    visits.push({
      kind: "server",
      url,
      preserveState: options.preserveState,
      preserveScroll: options.preserveScroll,
    });
    options.onFinish?.({});
  });
  for (const kind of ["push", "replace"] as const) {
    context.mock.method(router, kind, (params) => {
      visits.push({
        kind,
        url: params.url,
        preserveState: params.preserveState,
        preserveScroll: params.preserveScroll,
      });
      params.onFinish?.(params);
    });
  }
  return visits;
}

export function application(label: string, hydrated = {}, isServer = false) {
  const app = createSSRApp({ render: () => null });
  const requests: string[] = [];
  const runtime = createDmsFrontendRuntime(
    async (url: string) => {
      requests.push(url);
      await new Promise((resolve) =>
        setTimeout(resolve, label === "first" ? 10 : 1),
      );
      return label;
    },
    hydrated,
    isServer,
  );
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime, requests };
}

export function mountRuntime(runtime, root) {
  const node = () => ({ parent: null, children: [] });
  const renderer = createRenderer({
    createElement: node,
    createText: node,
    createComment: node,
    setText() {},
    setElementText() {},
    patchProp() {},
    parentNode: (child) => child.parent,
    nextSibling: () => null,
    insert(child, parent) {
      child.parent = parent;
      parent.children.push(child);
    },
    remove(child) {
      child.parent.children = child.parent.children.filter(
        (other) => other !== child,
      );
    },
  });
  const app = renderer.createApp(root);
  provideDmsFrontendRuntime(app, runtime);
  app.mount(node());
  return app;
}

export async function registerGlobalMiddleware(
  ...handlers: DmsMiddleware[]
): Promise<void> {
  await setupFrontendModules([
    {
      module: {
        setup(sdk) {
          handlers.forEach((handler, index) =>
            sdk.registerMiddleware(`test-middleware-${index}`, handler, {
              global: true,
            }),
          );
        },
      },
      options: { public: {} },
    },
  ]);
}
