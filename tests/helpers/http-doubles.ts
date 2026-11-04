import {
  type IncomingHttpHeaders,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { Socket } from "node:net";

/** The parts of a request the server under test reads. */
interface RequestInit {
  method?: string;
  url?: string;
  headers?: IncomingHttpHeaders;
}

/** A request that never touched a socket, with the given method, URL and headers. */
export function requestOf(init: RequestInit = {}): IncomingMessage {
  const request = new IncomingMessage(new Socket());
  request.method = init.method;
  request.url = init.url;
  request.headers = init.headers ?? {};
  return request;
}

/** A response that never touched a socket: the headers written to it stay readable. */
export function responseOf(request = requestOf()): ServerResponse {
  return new ServerResponse(request);
}
