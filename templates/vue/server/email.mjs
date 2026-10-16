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
// A render waits this long for a build in progress, then tries the bundle
// already on disk rather than holding the backend's request indefinitely.
const EMAIL_BUILD_WAIT_MS = 60_000;

// Settled whenever no email build is running. The version changes with each
// finished build: Node caches an imported module by URL, so the renderer is
// imported under a new one to pick up rebuilt templates.
let emailBuild = Promise.resolve();
let settleEmailBuild;
let emailBundleVersion = 0;

function emailBuildStarted() {
  if (settleEmailBuild) return;
  emailBuild = new Promise((settle) => {
    settleEmailBuild = settle;
  });
}

function emailBuildSettled() {
  emailBundleVersion += 1;
  settleEmailBuild?.();
  settleEmailBuild = undefined;
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
    if (message?.state === "building") emailBuildStarted();
    else emailBuildSettled();
  });
  builder.on("exit", (code) => {
    emailBuildSettled();
    if (code) console.error(`DMS email bundle watcher exited with ${code}`);
  });
  return builder;
}

async function loadEmailRenderer() {
  let timer;
  await Promise.race([
    emailBuild,
    new Promise((settle) => {
      timer = setTimeout(settle, EMAIL_BUILD_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
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
  const { renderEmail } = await loadEmailRenderer();
  return renderEmail(template, props, options);
}
