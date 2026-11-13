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

/**
 * Builds a workspace whose one module, `@acme/auth-frontend`, has `entry` as
 * its `dms.server.ts`, and serves it in production in front of `backend`,
 * with cookies that are not `Secure`.
 *
 * @param prefix The workspace directory's name prefix, in the current directory
 * @param entry The module's `dms.server.ts` source
 * @param backend Answers the frontend's backend calls
 * @param secret `DMS_SESSION_SECRET` while the servers run
 */
export async function startAuthServer(
  prefix: string,
  entry: string,
  backend: RequestListener,
  secret: string,
): Promise<AuthServer> {
  const environment = {
    DMS_API_BASE_URL: process.env.DMS_API_BASE_URL,
    DMS_SESSION_SECRET: process.env.DMS_SESSION_SECRET,
    DMS_COOKIE_SECURE: process.env.DMS_COOKIE_SECURE,
  };
  const workspace = realpathSync(mkdtempSync(resolve(prefix)));
  const source = mkdtempSync(join(tmpdir(), "dms-auth-fixture-"));
  const backendServer = createServer(backend);
  process.env.DMS_API_BASE_URL = await listen(backendServer);
  process.env.DMS_SESSION_SECRET = secret;
  process.env.DMS_COOKIE_SECURE = "false";

  writeFile(source, "dms.server.ts", entry);
  copyStaticTemplates(workspace);
  writeFile(workspace, "package.json", '{"type":"module"}');
  const layers = [{ path: source, packageName: "@acme/auth-frontend" }];
  const registry = createFrontendModuleRegistry(workspace, layers);
  cpSync(source, registry.modules[0].root, { recursive: true });
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
      rmSync(source, { recursive: true, force: true });
    },
  };
}
