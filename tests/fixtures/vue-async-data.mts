import { renderToString } from "@vue/server-renderer";
import { type Component, createRenderer, createSSRApp } from "vue";
import * as runtimeModule from "../../templates/vue/frontend-module.ts";

const { createDmsFrontendRuntime, provideDmsFrontendRuntime } = runtimeModule;

export type Runtime = ReturnType<typeof createDmsFrontendRuntime>;

export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export const settle = () => new Promise((resolve) => setImmediate(resolve));

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export function serverRender(root: Component) {
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  const app = createSSRApp(root);
  provideDmsFrontendRuntime(app, runtime);
  return { runtime, render: () => renderToString(app) };
}

export function clientApp(runtime: Runtime = createDmsFrontendRuntime()) {
  const app = createSSRApp({ render: () => null });
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime };
}

/** Mounts components without a DOM, the way the browser runtime runs them. */
export function mountRuntime(runtime: Runtime, root: Component) {
  interface Node {
    parent: Node | null;
    children: Node[];
  }
  const node = (): Node => ({ parent: null, children: [] });
  const renderer = createRenderer<Node, Node>({
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
      if (!child.parent) return;
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
