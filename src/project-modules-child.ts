// The process `dev` reads a project's frontend modules in, one per read. The
// project's configuration and each module's `frontendModule` are loaded with
// Node's module cache, so a second read in the same process would see the
// files as they were at the first one: after the module store installs a
// module, `dev` would rebuild the workspace without it.
//
// Receives the `ProjectModulesOptions` as its first message and answers with
// a `ProjectModulesReply`. The messages the read reports are sent back for
// the CLI to print, not printed here.

import { CliError, getProcessUi, type Ui } from "@antelopejs/core/cli";
import {
  type ProjectFrontendModule,
  type ProjectModulesOptions,
  readProjectFrontendModules,
} from "./project-modules";

type MessageArgs = Parameters<Ui["message"]>;

export type ProjectModulesReply = { messages: MessageArgs[] } & (
  | { modules: ProjectFrontendModule[] }
  | { problem: CliError["problem"] }
  | { failure: string }
);

process.once("message", async (options: ProjectModulesOptions) => {
  const messages: MessageArgs[] = [];
  getProcessUi().message = (...args) => {
    messages.push(args);
  };
  let reply: ProjectModulesReply;
  try {
    reply = { messages, modules: await readProjectFrontendModules(options) };
  } catch (error) {
    reply =
      error instanceof CliError
        ? { messages, problem: error.problem }
        : {
            messages,
            failure:
              error instanceof Error
                ? (error.stack ?? error.message)
                : String(error),
          };
  }
  process.send?.(reply, () => process.disconnect());
});
