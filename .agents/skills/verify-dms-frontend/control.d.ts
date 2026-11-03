/**
 * The part of dms-control's journey API these journeys use. dms-control lives
 * in the dms checkout, which this repository does not depend on, so the
 * shapes are declared here and the journeys type-check without it.
 */

/** Anything a check can observe or a JSON answer can hold. */
export type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

export interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

export interface Target {
  role: string;
  name?: string | RegExp;
  exact?: boolean;
  nth?: number;
  withinRole?: string;
  withinName?: string;
}

export interface CheckOptions {
  timeoutMs?: number;
}

export interface Cookie {
  name: string;
  value: string;
}

export interface Request {
  url(): string;
  method(): string;
  resourceType(): string;
  headers(): Record<string, string>;
}

export interface Response {
  url(): string;
  status(): number;
  headers(): Record<string, string>;
  json(): Promise<Json>;
  text(): Promise<string>;
}

export interface Locator {
  click(options?: { timeout?: number }): Promise<void>;
  first(): Locator;
  waitFor(options?: { timeout?: number }): Promise<void>;
  isVisible(): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
}

export interface Page {
  url(): string;
  goto(url: string): Promise<Json>;
  content(): Promise<string>;
  on(event: "request", handler: (request: Request) => void): void;
  on(event: "response", handler: (response: Response) => void): void;
  waitForLoadState(state?: "load" | "domcontentloaded" | "networkidle"): Promise<void>;
  waitForURL(predicate: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  getByRole(role: string, options?: { name?: string | RegExp }): Locator;
  evaluate<T extends Json>(action: () => T): Promise<T>;
  context(): { cookies(): Promise<Cookie[]>; addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void> };
}

export interface Tab {
  page: Page;
  goto(path: string): Promise<Json>;
  reload(): Promise<Json>;
  click(target: Target): Promise<Json>;
  fill(target: Target, value: string): Promise<Json>;
  select(target: Target, value: string): Promise<Json>;
  check(target: Target): Promise<Json>;
  press(key: string, target?: Target): Promise<Json>;
  snapshot(label?: string): Promise<Json>;
  signIn(account: string): Promise<Json>;
  visible(target: Target, options?: CheckOptions): Promise<Check>;
  enabled(target: Target, options?: CheckOptions): Promise<Check>;
  shows(pattern: RegExp, options?: CheckOptions): Promise<Check>;
  at(pattern: RegExp, options?: CheckOptions): Promise<Check>;
  count(target: Target, expected: number): Promise<Check>;
  value(target: Target): Promise<string>;
  close(): Promise<void>;
}

export interface Credentials {
  email: string;
  password: string;
}

export interface RunState {
  id: string;
  dir: string;
  home: string;
  logs: string;
  evidence: string;
  mail: string;
  root: string;
  runPlayground?: string;
  renderer?: string;
  environment: string;
  apiUrl: string;
  webUrl: string;
  apiPort: number;
  webPort: number;
  smtpPort: number;
  mongoUrl: string;
  database: string;
  secrets: Record<string, string>;
  extraEnv: Record<string, string>;
  accounts: Record<string, Credentials>;
}

export interface ApiRequest {
  method: string;
  path: string;
  body?: Json;
  as?: string;
  token?: string;
}

export interface ApiAnswer {
  status: number | null;
  body: Json;
  error: string | null;
  folder?: string;
}

export interface CapturedMail {
  file: string;
  from: string;
  to: string[];
  subject: string;
  links: string[];
  text: string;
  receivedAt: string;
}

export interface MailResult {
  folder: string;
  messages: CapturedMail[];
  match: CapturedMail | undefined;
}

export interface VerifyOptions {
  critical?: boolean;
}

export interface JourneyContext {
  state: RunState;
  step(label: string): string;
  verify(label: string, checks: (Check | Promise<Check>)[], options?: VerifyOptions): Promise<boolean>;
  tab(account?: string, label?: string): Promise<Tab>;
  api(label: string, request: ApiRequest): Promise<ApiAnswer>;
  email(name: string): string;
  unique(prefix: string): string;
  password(): string;
  adminCredentials(): Credentials;
  setupToken(): string;
  restartBackend(): Promise<Json>;
  mail(accept: (message: CapturedMail) => boolean, timeoutMs?: number): Promise<MailResult>;
  equal(name: string, actual: Json, expected: Json): Check;
  status(answer: { status: number | null; body: Json }, expected: number): Check;
  holds(name: string, pass: Json, detail: Json): Check;
  journey: string;
  steps: unknown[];
  record(folder: string, checks: Check[], options?: VerifyOptions): boolean;
}

export interface Journey {
  id: string;
  title: string;
  entryPoint: string;
  database?: string;
  onboard?: boolean;
  run(ctx: JourneyContext): Promise<void>;
}

export interface Locator {
  waitFor(options?: { state?: "attached" | "detached" | "visible" | "hidden"; timeout?: number }): Promise<void>;
  count(): Promise<number>;
}

export interface Page {
  locator(selector: string): Locator;
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator;
  context(): {
    cookies(): Promise<Cookie[]>;
    addCookies(cookies: { name: string; value: string; url: string }[]): Promise<void>;
    setOffline(offline: boolean): Promise<void>;
  };
}
