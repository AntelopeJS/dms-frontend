import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { router } from "@inertiajs/vue3";
import { type Component, createSSRApp, createRenderer } from "vue";
import {
  createDmsFrontendRuntime,
  type DmsFrontendRuntime,
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

/** What the recorded `router.visit` reads of its options. */
interface VisitOptions {
  preserveState?: unknown;
  preserveScroll?: unknown;
  onFinish?: (finished: Record<string, never>) => void;
}

/** What the recorded `router.push` and `router.replace` read of theirs. */
interface HistoryParams {
  url: string;
  preserveState?: unknown;
  preserveScroll?: unknown;
  onFinish?: (finished: HistoryParams) => void;
}

/** What the headless renderer builds in place of DOM nodes. */
interface TestNode {
  parent: TestNode | null;
  children: TestNode[];
}

export function recordVisits(context: TestContext) {
  const visits: RecordedVisit[] = [];
  context.mock.method(
    router,
    "visit",
    (url: string, options: VisitOptions = {}) => {
      visits.push({
        kind: "server",
        url,
        preserveState: options.preserveState,
        preserveScroll: options.preserveScroll,
      });
      options.onFinish?.({});
    },
  );
  for (const kind of ["push", "replace"] as const) {
    context.mock.method(router, kind, (params: HistoryParams) => {
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

export function mountRuntime(runtime: DmsFrontendRuntime, root: Component) {
  const node = (): TestNode => ({ parent: null, children: [] });
  const renderer = createRenderer<TestNode, TestNode>({
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
      assert.ok(child.parent, "a removed node was inserted first");
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
