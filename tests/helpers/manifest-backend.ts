import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Manifest } from "../../src/common";
import { addressOf } from "./net";

interface FrontendManifest {
  version: number;
  modules: Manifest["modules"];
}

export const frontendManifest: FrontendManifest = {
  version: 2,
  modules: [],
};

export interface Backend {
  server: Server;
  baseUrl: string;
  requests: string[];
  headers: IncomingHttpHeaders[];
}

export function startBackend(status = 200, answer?: string): Promise<Backend> {
  return new Promise((resolve) => {
    const requests: string[] = [];
    const headers: IncomingHttpHeaders[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      headers.push(req.headers);
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(
        status === 200
          ? (answer ?? JSON.stringify(frontendManifest))
          : JSON.stringify({ error: "nope" }),
      );
    });
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      const address = addressOf(server);
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        headers,
      });
    });
  });
}

export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
