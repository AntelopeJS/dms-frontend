import { fork } from "node:child_process";
import { constants, setPriority } from "node:os";
import { fileURLToPath } from "node:url";

const EMAIL_RENDERER_URL = new URL(
  "../dist/server/email-renderer.js",
  import.meta.url,
);
const EMAIL_BUNDLE_WATCH_URL = new URL(
  "./email-bundle-watch.mjs",
  import.meta.url,
);
// Bound the request's wait, but never read a bundle being replaced.
const EMAIL_BUILD_WAIT_MS = 60_000;

// Settled whenever no email build is running. The version changes with each
// finished build: Node caches an imported module by URL, so the renderer is
// imported under a new one to pick up rebuilt templates.
let emailBuild = Promise.resolve();
let settleEmailBuild;
let emailBundleVersion = 0;
// A build empties dist/server before it writes the new bundle, so it never
// starts while a render still imports from the previous one: the builder asks
// first, and gets the go-ahead once the renders in progress have finished.
let rendersInProgress = 0;
let startPendingBuild;

function emailBuildStarted() {
  if (settleEmailBuild) return;
  emailBuild = new Promise((settle) => {
    settleEmailBuild = settle;
  });
}

function emailBuildSettled() {
  emailBundleVersion += 1;
  startPendingBuild = undefined;
  settleEmailBuild?.();
  settleEmailBuild = undefined;
}

function startBuildOnceRendersFinish(start) {
  if (rendersInProgress) startPendingBuild = start;
  else start();
}

function renderFinished() {
  rendersInProgress -= 1;
  if (rendersInProgress || !startPendingBuild) return;
  const start = startPendingBuild;
  startPendingBuild = undefined;
  start();
}

/**
 * Build the email bundle now and again on every template change, for
 * development: only the production build otherwise produces it. The builder
 * runs in a child process at low priority, so the dev server keeps answering
 * while it works.
 */
export function watchEmailBundle() {
  emailBuildStarted();
  const builder = fork(fileURLToPath(EMAIL_BUNDLE_WATCH_URL), {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  try {
    setPriority(builder.pid, constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // Not permitted on this platform; the build only runs at normal priority.
  }
  builder.on("message", (message) => {
    if (message?.state !== "building") {
      emailBuildSettled();
      return;
    }
    emailBuildStarted();
    startBuildOnceRendersFinish(() => {
      if (builder.connected) builder.send({ state: "build" });
    });
  });
  builder.on("exit", (code) => {
    emailBuildSettled();
    if (code) console.error(`DMS email bundle watcher exited with ${code}`);
  });
  return builder;
}

async function waitForEmailBuild() {
  const deadline = Date.now() + EMAIL_BUILD_WAIT_MS;
  // Another build may start while a render waits for the previous one.
  while (settleEmailBuild && Date.now() < deadline) {
    let timer;
    await Promise.race([
      emailBuild,
      new Promise((settle) => {
        timer = setTimeout(settle, deadline - Date.now());
      }),
    ]);
    clearTimeout(timer);
  }
  if (settleEmailBuild) {
    throw new Error("Timed out waiting for the email bundle build");
  }
}

function loadEmailRenderer() {
  const url = new URL(EMAIL_RENDERER_URL);
  if (emailBundleVersion) url.searchParams.set("v", emailBundleVersion);
  return import(url.href);
}

/**
 * Renders an email template of the application's email bundle, waiting for a
 * development build in progress.
 *
 * @param template The template's name
 * @param props The template's props
 * @param options `locale`, the language to render in
 */
export async function renderEmailTemplate(template, props, options = {}) {
  await waitForEmailBuild();
  // Counted from here, with no await in between, so a build the builder asks
  // for now waits for this render, which imports templates and reads catalogs
  // from the bundle until it ends.
  rendersInProgress += 1;
  try {
    const { renderEmail } = await loadEmailRenderer();
    return await renderEmail(template, props, options);
  } finally {
    renderFinished();
  }
}
