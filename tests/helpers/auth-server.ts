import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  copyStaticTemplates,
  createFrontendModuleRegistry,
  writeFrontendModuleRegistry,
} from "../../src/common";
import { addressOf } from "./net";
import { requestHandlerOf } from "./workspace-server";

/** A production frontend server and the backend it fronts. */
export interface AuthServer {
  /** The frontend's origin. */
  url: string;
  /** Stops both servers, restores the environment and removes the workspace. */
  close(): Promise<void>;
}

function writeFile(root: string, path: string, content: string): void {
  const destination = join(root, path);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
  return `http://127.0.0.1:${addressOf(server).port}`;
}

function close(server: Server): Promise<void> {
  return new Promise((settle) => {
    if (!server.listening) return settle();
    server.closeAllConnections();
    server.close(() => settle());
  });
}

/** A module of the workspace: its package name, priority and `dms.server.ts` source. */
export interface ServerModuleSource {
  packageName: string;
  priority?: number;
  entry: string;
}

/**
 * Builds a workspace of `modules`, each with its `dms.server.ts`, and serves
 * it in production in front of `backend`, with cookies that are not `Secure`.
 *
 * @param prefix The workspace directory's name prefix, in the current directory
 * @param modules The workspace's modules
 * @param backend Answers the frontend's backend calls
 * @param secret `DMS_SESSION_SECRET` while the servers run
 */
export async function startAuthServer(
  prefix: string,
  modules: readonly ServerModuleSource[],
  backend: RequestListener,
  secret: string,
): Promise<AuthServer> {
  const environment = {
    DMS_API_BASE_URL: process.env.DMS_API_BASE_URL,
    DMS_SESSION_SECRET: process.env.DMS_SESSION_SECRET,
    DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE,
  };
  const workspace = realpathSync(mkdtempSync(resolve(prefix)));
  const sources = modules.map(() =>
    mkdtempSync(join(tmpdir(), "dms-auth-fixture-")),
  );
  const backendServer = createServer(backend);
  process.env.DMS_API_BASE_URL = await listen(backendServer);
  process.env.DMS_SESSION_SECRET = secret;
  process.env.DMS_COOKIE_SECURE = "false";

  copyStaticTemplates(workspace);
  writeFile(workspace, "package.json", '{"type":"module"}');
  const layers = modules.map(({ packageName, priority }, index) => ({
    path: sources[index],
    packageName,
    priority,
  }));
  modules.forEach(({ entry }, index) =>
    writeFile(sources[index], "dms.server.ts", entry),
  );
  const registry = createFrontendModuleRegistry(workspace, layers);
  sources.forEach((source, index) =>
    cpSync(source, registry.modules[index].root, { recursive: true }),
  );
  writeFrontendModuleRegistry(workspace, layers);
  const { build } = await import("vite");
  await build({
    configFile: join(workspace, "vite.server.config.ts"),
    root: workspace,
    logLevel: "silent",
  });
  const frontend = createServer(await requestHandlerOf(workspace));
  const url = await listen(frontend);
  return {
    url,
    async close() {
      await close(frontend);
      await close(backendServer);
      for (const [name, value] of Object.entries(environment))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      rmSync(workspace, { recursive: true, force: true });
      for (const source of sources)
        rmSync(source, { recursive: true, force: true });
    },
  };
}
