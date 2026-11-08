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
  remoteAddress?: string;
  encrypted?: boolean;
}

/** A socket that answers the peer address and the TLS flag it is given, without connecting. */
function socketOf(init: RequestInit): Socket {
  const socket = new Socket();
  Object.defineProperties(socket, {
    remoteAddress: { value: init.remoteAddress },
    encrypted: { value: init.encrypted },
  });
  return socket;
}

/** A request that never touched a socket, with the given method, URL, headers and peer. */
export function requestOf(init: RequestInit = {}): IncomingMessage {
  const request = new IncomingMessage(socketOf(init));
  request.method = init.method;
  request.url = init.url;
  request.headers = init.headers ?? {};
  return request;
}

/** A response that never touched a socket: the headers written to it stay readable. */
export function responseOf(request = requestOf()): ServerResponse {
  return new ServerResponse(request);
}
