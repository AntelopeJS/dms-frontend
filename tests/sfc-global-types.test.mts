import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import ts from "typescript";
import {
  compileScript,
  invalidateTypeCache,
  parse,
  registerTS,
} from "vue/compiler-sfc";
import {
  sfcGlobalTypes,
  sfcGlobalTypesWatcher,
  writeSfcGlobalTypes,
} from "../templates/vue/sfc-global-types.mjs";
import { readText } from "./helpers/files";

registerTS(() => ts);

function writeFixture(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

const COMPONENT = `<script setup lang="ts">
defineProps<{
  action?: boolean | ActionRule;
  target?: string | Component;
  hidden?: boolean | InternalRule;
}>();
</script>
<template><div /></template>
`;

/**
 * A workspace with one module that auto-imports its `app/types`, as its
 * `dms.frontend.build.ts` would declare: the directories the Vite config
 * hands the auto-import plugin.
 */
const workspaces: string[] = [];
after(() => {
  for (const root of workspaces.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function workspace() {
  const root = realpathSync(mkdtempSync(resolve(".sfc-global-types-")));
  workspaces.push(root);
  const module = join(root, "frontend-modules", "acme");
  writeFixture(
    module,
    "app/types/action.ts",
    "export interface ActionRule { field: string; equals: unknown }\n",
  );
  writeFixture(
    module,
    "app/build/types/internal.ts",
    "export interface InternalRule { secret: string }\n",
  );
  writeFixture(module, "app/components/Panel.vue", COMPONENT);
  writeFixture(
    module,
    "app/components/Imported.vue",
    COMPONENT.replace(
      '<script setup lang="ts">\n',
      '<script setup lang="ts">\nimport type { Component } from "vue";\nimport type { ActionRule } from "../types/action";\n',
    ),
  );
  const dirs = [
    { glob: `${module}/app/types/**/*`, types: true },
    { glob: `!${module}/**/app/build/**`, types: true },
  ];
  return {
    root,
    module,
    dirs,
    file: join(root, "sfc-global-types.generated.d.ts"),
  };
}

const compilerFs = {
  fileExists: (file: string) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  readFile: (file: string) => readText(file),
  realpath: (file: string) => realpathSync(file),
};

/** The runtime props, as `@vitejs/plugin-vue` compiles them. */
function compiledProps(
  component: string,
  isProd: boolean,
  globalTypeFiles?: string[],
): string {
  const { descriptor } = parse(readText(component), {
    filename: component,
  });
  const { content } = compileScript(descriptor, {
    id: "panel",
    isProd,
    fs: compilerFs,
    globalTypeFiles,
  });
  return content;
}

describe("the auto-imported types, declared for the SFC compiler", () => {
  it("lets a prop typed with one compile to its real runtime type", async () => {
    const { root, module, dirs, file } = workspace();
    const component = join(module, "app/components/Panel.vue");

    for (const isProd of [false, true])
      assert.match(
        compiledProps(component, isProd),
        /action: \{ type: Boolean[,\s}]/,
      );

    await writeSfcGlobalTypes(dirs, root, file);

    const imported = join(module, "app/components/Imported.vue");
    const propLine = (code: string, name: string) =>
      code.split("\n").find((line) => line.trim().startsWith(`${name}:`));
    for (const isProd of [false, true]) {
      const props = compiledProps(component, isProd, [file]);
      assert.match(props, /action: \{ type: \[Boolean, Object\]/);
      assert.doesNotMatch(props, /action: [^\n]*skipCheck/);
      const reference = compiledProps(imported, isProd);
      for (const name of ["action", "target"])
        assert.equal(propLine(props, name), propLine(reference, name), name);
    }
  });

  it("declares what the auto-imports expose, and only that", async () => {
    const { root, dirs } = workspace();
    const declarations = await sfcGlobalTypes(dirs, root);
    assert.match(
      declarations,
      /^declare type ActionRule = import\(".*\/frontend-modules\/acme\/app\/types\/action"\)\.ActionRule;$/m,
    );
    assert.match(
      declarations,
      /^declare type Component = import\("vue"\)\.Component;$/m,
    );
    assert.doesNotMatch(declarations, /InternalRule/);
  });

  it("lets a module's type shadow Vue's of the same name, as the auto-imports do", async () => {
    const { root, module, dirs } = workspace();
    writeFixture(
      module,
      "app/types/component.ts",
      "export interface Component { slot: string }\n",
    );
    const declarations = await sfcGlobalTypes(dirs, root);
    assert.match(
      declarations,
      /^declare type Component = import\(".*\/frontend-modules\/acme\/app\/types\/component"\)\.Component;$/m,
    );
    assert.doesNotMatch(declarations, /import\("vue"\)\.Component;/);
  });

  it("follows a type file added to a dev server's workspace", async () => {
    const { root, module, dirs, file } = workspace();
    await writeSfcGlobalTypes(dirs, root, file);
    const watcher = new EventEmitter();
    const plugin = sfcGlobalTypesWatcher(dirs, root, file);
    (plugin.configureServer as (server: unknown) => void)({ watcher });

    const added = join(module, "app/types/later.ts");
    writeFixture(
      module,
      "app/types/later.ts",
      "export type LaterRule = { a: 1 };\n",
    );
    watcher.emit("add", added);
    await delay(400);

    assert.match(readText(file), /declare type LaterRule = /);
    invalidateTypeCache(file);
  });

  it("warns, rather than ending the dev server, when it cannot rewrite them", async () => {
    const { root, module, dirs } = workspace();
    const file = join(root, "missing", "sfc-global-types.generated.d.ts");
    const warnings: string[] = [];
    const watcher = new EventEmitter();
    const plugin = sfcGlobalTypesWatcher(dirs, root, file);
    (plugin.configureServer as (server: unknown) => void)({
      watcher,
      config: { logger: { warn: (message: string) => warnings.push(message) } },
    });

    watcher.emit("change", join(module, "app/types/action.ts"));
    await delay(400);

    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /Could not update .*sfc-global-types/);
  });
});
