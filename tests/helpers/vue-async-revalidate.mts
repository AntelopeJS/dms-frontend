import assert from "node:assert/strict";
import { renderToString } from "@vue/server-renderer";
import {
  type Component,
  createRenderer,
  createSSRApp,
  defineComponent,
  h,
  ref,
} from "vue";
import * as runtimeModule from "../../templates/vue/frontend-module.ts";

const { createDmsFrontendRuntime, provideDmsFrontendRuntime, useDmsAsyncData } =
  runtimeModule;

type Runtime = ReturnType<typeof createDmsFrontendRuntime>;

export const settle = () => new Promise((resolve) => setImmediate(resolve));
export const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until `reached` holds, however slow the machine, and fails after 1 s. */
export async function until(reached: () => boolean, message: () => string) {
  const deadline = Date.now() + 1_000;
  while (!reached()) {
    assert.ok(Date.now() < deadline, message());
    await sleep(5);
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function clientApp(runtime: Runtime = createDmsFrontendRuntime()) {
  const app = createSSRApp({ render: () => null });
  provideDmsFrontendRuntime(app, runtime);
  return { app, runtime };
}

export function serverRender(
  root: Component,
  prepare?: (runtime: Runtime) => void,
) {
  const runtime = createDmsFrontendRuntime(undefined, {}, true);
  prepare?.(runtime);
  const app = createSSRApp(root);
  provideDmsFrontendRuntime(app, runtime);
  return { runtime, render: () => renderToString(app) };
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

/** A component showing `key`, which a ref mounts and unmounts. */
export function toggled(key: string, handler: () => Promise<string>) {
  const visible = ref(true);
  const shown: string[] = [];
  const Consumer = defineComponent({
    setup() {
      const { data, status } = useDmsAsyncData(key, handler);
      return () => {
        shown.push(`${status.value}:${String(data.value)}`);
        return h("p");
      };
    },
  });
  return {
    visible,
    shown,
    root: { render: () => (visible.value ? h(Consumer) : null) },
  };
}
