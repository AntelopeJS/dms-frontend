import * as assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
  createPathMapper,
  describeChildFailure,
  failureTail,
  InstallProgress,
  LineSplitter,
  OutputTail,
  stripAnsi,
  VERBOSE_OUTPUT_HINT,
} from "../src/child-output";
import type { ResolvedLayer } from "../src/workspace";
import { runFramedCommand } from "../src/workspace-setup";

const WORKSPACE = "/home/user/.antelopejs/dms-frontend/f6af15c7221e3402";

describe("child output lines", () => {
  it("splits a stream into lines whatever the chunk boundaries", () => {
    const lines: string[] = [];
    const splitter = new LineSplitter((line) => lines.push(line));
    splitter.push("Progress: resol");
    splitter.push("ved 1\r\nPackages: +3\nDone");
    assert.deepEqual(lines, ["Progress: resolved 1", "Packages: +3"]);
    splitter.flush();
    assert.deepEqual(lines, ["Progress: resolved 1", "Packages: +3", "Done"]);
    splitter.flush();
    assert.equal(lines.length, 3);
  });

  it("keeps only the last lines of a long output", () => {
    const tail = new OutputTail(3);
    for (const line of ["1", "2", "3", "4", "5"]) tail.push(line);
    assert.deepEqual(tail.lines(), ["3", "4", "5"]);
  });

  it("removes colors", () => {
    assert.equal(stripAnsi("\u001b[33m(!) chunk\u001b[39m"), "(!) chunk");
  });
});

describe("the output a framed child leaves", () => {
  it("keeps stdout, then stderr, whichever pipe was read first", async () => {
    // stderr is written, and read, long before stdout.
    const script = [
      'process.stderr.write("ERR_PNPM_FETCH_404\\n");',
      'setTimeout(() => { process.stdout.write("line 1\\nline 2\\n"); process.exitCode = 1; }, 100);',
    ].join("");
    const result = await runFramedCommand(process.execPath, ["-e", script], {
      name: "node",
      cwd: process.cwd(),
    });

    assert.equal(result.code, 1);
    assert.deepEqual(result.lines, ["line 1", "line 2", "ERR_PNPM_FETCH_404"]);
  });
});

describe("the output a failure replays", () => {
  const output = [
    ...Array.from({ length: 30 }, (_, index) => `line ${index + 1}`),
    "",
    "(node:42) [DEP0169] DeprecationWarning: `url.parse()` behavior is not standardized",
    "(Use `node --trace-deprecation ...` to show where the warning was created)",
    "\u001b[31m ERR_PNPM_FETCH_404\u001b[39m  GET https://registry.npmjs.org/nope: Not Found - 404",
    "    at fetch (/pnpm/dist/pnpm.cjs:1:1)",
  ];

  it("is the last fifteen lines, without blanks, colors or Node notices", () => {
    const tail = failureTail(output);
    assert.equal(tail.length, 15);
    assert.equal(tail[0], "line 17");
    assert.equal(
      tail[14],
      " ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/nope: Not Found - 404",
    );
    assert.ok(tail.every((line) => !line.includes("DEP0169")));
    assert.ok(tail.every((line) => !line.includes("trace-deprecation")));
  });

  it("drops stack frames unless they are asked for", () => {
    assert.ok(failureTail(output).every((line) => !line.includes(" at ")));
    assert.match(failureTail(output, 15, true)[14], /^ {4}at fetch/);
  });

  it("follows the exit code, then ends on the way to see everything", () => {
    const problem = describeChildFailure({
      title: "Dependency install failed",
      command: "pnpm install",
      code: 1,
      lines: output,
      isVerbose: false,
    });
    assert.equal(problem.title, "Dependency install failed");
    assert.equal(problem.reason, "pnpm install exited with code 1.");
    assert.equal(problem.details?.length, 16);
    assert.equal(problem.details?.[15], VERBOSE_OUTPUT_HINT);
  });

  it("is not replayed when a verbose run streamed it", () => {
    const problem = describeChildFailure({
      title: "Dependency install failed",
      command: "pnpm install",
      code: 1,
      lines: output,
      isVerbose: true,
    });
    assert.equal(
      problem.reason,
      "pnpm install exited with code 1; its output is above.",
    );
    assert.equal(problem.details, undefined);
  });
});

describe("workspace paths in child output", () => {
  let sources: string;
  let demoSource: string;
  let layers: ResolvedLayer[];

  before(() => {
    sources = mkdtempSync(join(tmpdir(), "dms-frontend-paths-"));
    demoSource = join(sources, "frontend-vue");
    mkdirSync(demoSource);
    layers = [
      {
        path: join(WORKSPACE, ".layers-cache/template-dms-demo-frontend-vue"),
        sourcePath: demoSource,
        packageName: "template-dms-demo-frontend-vue",
      },
      {
        path: join(WORKSPACE, ".layers-cache/antelopejs__dms-frontend-vue"),
        packageName: "@antelopejs/dms-frontend-vue",
      },
      {
        path: join(WORKSPACE, ".layers-cache/antelopejs__dms-frontend-vue-x"),
        packageName: "@antelopejs/dms-frontend-vue-x",
      },
    ];
  });
  after(() => rmSync(sources, { recursive: true, force: true }));

  const mapper = (platform: NodeJS.Platform = "linux") =>
    createPathMapper(WORKSPACE, layers, {
      showSource: (path) => path.replace(`${sources}/`, ""),
      shownWorkspace: "~/.antelopejs/dms-frontend/f6af15c7…",
      platform,
    });

  it("names the source a layer was copied from", () => {
    assert.equal(
      mapper()(
        `file: ${WORKSPACE}/frontend-modules/template-dms-demo-frontend-vue/app/components/Callout.vue:10:50`,
      ),
      "file: frontend-vue/app/components/Callout.vue:10:50",
    );
  });

  it("names the package of a layer whose source is not on this disk", () => {
    assert.equal(
      mapper()(
        `(!) ${WORKSPACE}/frontend-modules/antelopejs__dms-frontend-vue/layers/dms-ui/app/Modal.vue is dynamically imported`,
      ),
      "(!) @antelopejs/dms-frontend-vue/layers/dms-ui/app/Modal.vue is dynamically imported",
    );
  });

  it("does not mistake a layer for another whose name it starts", () => {
    assert.equal(
      mapper()(
        `${WORKSPACE}/frontend-modules/antelopejs__dms-frontend-vue-x/app/a.ts`,
      ),
      "@antelopejs/dms-frontend-vue-x/app/a.ts",
    );
  });

  it("maps paths relative to the workspace too", () => {
    assert.equal(
      mapper()(
        'Could not resolve "./Foo.vue" from "frontend-modules/template-dms-demo-frontend-vue/app/pages/index.vue"',
      ),
      'Could not resolve "./Foo.vue" from "frontend-vue/app/pages/index.vue"',
    );
    assert.equal(
      mapper()(
        "+ template-dms-demo-frontend-vue 0.0.1 <- frontend-modules/template-dms-demo-frontend-vue",
      ),
      "+ template-dms-demo-frontend-vue 0.0.1 <- frontend-vue",
    );
  });

  it("shortens any other path into the workspace", () => {
    assert.equal(
      mapper()(`> vite build ${WORKSPACE}/node_modules/.pnpm/vite/index.js`),
      "> vite build ~/.antelopejs/dms-frontend/f6af15c7…/node_modules/.pnpm/vite/index.js",
    );
  });

  it("reads backslashes and any drive letter case on Windows", () => {
    const windowsWorkspace = WORKSPACE.replace(/\//g, "\\");
    assert.equal(
      mapper("win32")(
        `${windowsWorkspace.toUpperCase()}\\frontend-modules\\template-dms-demo-frontend-vue\\app\\a.vue`,
      ),
      "frontend-vue\\app\\a.vue",
    );
  });

  it("leaves lines without workspace paths alone", () => {
    const line = "Progress: resolved 548, reused 446, downloaded 0, added 448";
    assert.equal(mapper()(line), line);
  });
});

describe("pnpm install progress", () => {
  it("follows the counts pnpm prints, then says what it installed", () => {
    const progress = new InstallProgress();
    assert.equal(progress.label, "Installing dependencies");
    assert.equal(progress.read("Scope: all 13 workspace projects"), false);
    assert.equal(
      progress.read("Progress: resolved 39, reused 38, downloaded 0, added 0"),
      true,
    );
    assert.equal(
      progress.label,
      "Installing dependencies · 39 resolved, 0 added",
    );
    progress.read("Packages: +448");
    progress.read(
      "Progress: resolved 548, reused 446, downloaded 0, added 448, done",
    );
    assert.equal(
      progress.label,
      "Installing dependencies · 548 resolved, 448 added",
    );
    assert.equal(progress.doneLabel, "Installed 448 packages");
  });

  it("says when nothing had to change", () => {
    const progress = new InstallProgress();
    progress.read("Lockfile is up to date, resolution step is skipped");
    progress.read("Already up to date");
    assert.equal(progress.doneLabel, "Dependencies up to date");
    assert.equal(new InstallProgress().doneLabel, "Installed the dependencies");
  });
});
