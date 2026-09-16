import { clientIp } from "./client-ip.mjs";

const FORWARDED_HEADERS = [
  "user-agent",
  "x-content-language",
  "x-realtime-session",
];
const BODY_LIMIT = 64 * 1024;

export class UpstreamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PUBLIC_AUTH_MESSAGE = /^error\.[a-z0-9_.-]{1,100}$/;

export function publicBackendMessage(data) {
  const message = typeof data === "string" ? data : data?.message;
  return typeof message === "string" && PUBLIC_AUTH_MESSAGE.test(message)
    ? message
    : undefined;
}

export async function backend(path, request, options = {}) {
  const headers = Object.fromEntries(
    FORWARDED_HEADERS.flatMap((name) =>
      request.headers[name] ? [[name, request.headers[name]]] : [],
    ),
  );
  headers["x-forwarded-for"] = clientIp(request);
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.relay)
    headers["x-dms-oauth-relay"] = process.env.DMS_OAUTH_RELAY_SECRET ?? "";
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(new URL(path, process.env.DMS_API_BASE_URL), {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = response.ok ? {} : text;
  }
  if (!response.ok) {
    const message = publicBackendMessage(data) ?? "DMS backend request failed";
    throw new UpstreamError(response.status, message);
  }
  return data;
}

export async function body(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > BODY_LIMIT)
      throw new RequestBodyError(413, "Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new RequestBodyError(400, "Invalid request body");
  }
}

export class RequestBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
