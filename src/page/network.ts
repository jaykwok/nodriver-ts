import type { Protocol } from 'devtools-protocol';
import type { Session } from '../protocol/connection.js';
import type { Tab } from './tab.js';
import { EventHub, type WaitOptions } from '../utils.js';
import { NodriverError } from '../errors.js';
export class Route {
  private handled = false;
  constructor(
    readonly session: Session,
    readonly request: Protocol.Fetch.RequestPausedEvent,
  ) {}
  get done(): boolean {
    return this.handled;
  }
  private claim(): void {
    if (this.handled) throw new NodriverError('Route already handled');
    this.handled = true;
  }
  async continue(
    overrides: Omit<Protocol.Fetch.ContinueRequestRequest, 'requestId'> = {},
  ): Promise<void> {
    this.claim();
    await this.session.send('Fetch.continueRequest', {
      ...overrides,
      requestId: this.request.requestId,
    });
  }
  async abort(reason: Protocol.Network.ErrorReason = 'Aborted'): Promise<void> {
    this.claim();
    await this.session.send('Fetch.failRequest', {
      requestId: this.request.requestId,
      errorReason: reason,
    });
  }
  async fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }): Promise<void> {
    this.claim();
    await this.session.send('Fetch.fulfillRequest', {
      requestId: this.request.requestId,
      responseCode: options.status ?? 200,
      responseHeaders: Object.entries(options.headers ?? {}).map(([name, value]) => ({
        name,
        value,
      })),
      body: Buffer.from(options.body ?? '').toString('base64'),
    });
  }
}
export interface Response {
  event: Protocol.Network.ResponseReceivedEvent;
  body(): Promise<Buffer>;
}
/** An event hub that runs a hook when the first listener subscribes. */
class LazyHub<T> extends EventHub<T> {
  constructor(private readonly subscribed: () => void) {
    super();
  }
  override on(listener: (event: T) => void | Promise<void>): () => void {
    this.subscribed();
    return super.on(listener);
  }
}
/**
 * Request interception, credentials and response observation for a tab and its OOPIFs.
 * Network.enable is sent only once a feature needs it (responses, headers, cache, offline,
 * or an explicit enable()); routes and authentication use the Fetch domain alone.
 */
export class Network {
  /** Subscribing (directly or via waitForResponse) enables the Network domain. */
  readonly responses: EventHub<Response> = new LazyHub(() => {
    if (!this.wanted) void this.enable().catch((e) => this.tab.reportError(e));
  });
  private wanted = false;
  // Retain the in-flight setup too: every caller must wait until CDP has enabled the domain.
  private enabled = new Map<Session, Promise<void>>();
  private routes: Array<{ pattern: RegExp; handler: (route: Route) => Promise<void> | void }> = [];
  private credentials?: { username: string; password: string };
  private headers: Record<string, string> = {};
  private cacheEnabled = true;
  private offline = false;
  private configured = new Set<Session>();
  private authAttempts = new Set<string>();
  constructor(private tab: Tab) {}
  async configure(session: Session): Promise<void> {
    if (this.configured.has(session)) return;
    this.configured.add(session);
    session.disconnected.on(() => {
      this.configured.delete(session);
      this.enabled.delete(session);
      for (const key of this.authAttempts)
        if (key.startsWith(`${session.id}:`)) this.authAttempts.delete(key);
    });
    session.on('Network.responseReceived', (event) => {
      this.responses.emit({
        event,
        body: async () => {
          const r = await session.send('Network.getResponseBody', { requestId: event.requestId });
          return Buffer.from(r.body, r.base64Encoded ? 'base64' : 'utf8');
        },
      });
    });
    session.on('Fetch.requestPaused', async (event) => {
      const route = new Route(session, event);
      try {
        const match = this.routes.find((r) => {
          r.pattern.lastIndex = 0;
          return r.pattern.test(event.request.url);
        });
        if (match) await match.handler(route);
        if (!route.done) await route.continue();
      } catch (e) {
        this.tab.reportError(e);
        if (!route.done) await route.abort().catch(() => {});
      }
    });
    session.on('Fetch.authRequired', async (event) => {
      const key = `${session.id}:${event.requestId}`;
      const tried = this.authAttempts.has(key);
      this.authAttempts.add(key);
      if (this.authAttempts.size > 1024)
        this.authAttempts.delete(this.authAttempts.values().next().value!);
      await session.send('Fetch.continueWithAuth', {
        requestId: event.requestId,
        authChallengeResponse:
          this.credentials && !tried
            ? { response: 'ProvideCredentials', ...this.credentials }
            : { response: 'CancelAuth' },
      });
    });
    session.on('Network.loadingFinished', (e) => {
      this.authAttempts.delete(`${session.id}:${e.requestId}`);
    });
    session.on('Network.loadingFailed', (e) => {
      this.authAttempts.delete(`${session.id}:${e.requestId}`);
    });
    if (this.wanted) await this.enableSession(session);
    if (this.routes.length || this.credentials) await this.enableFetch(session);
  }
  get networkEnabled(): boolean {
    return this.wanted;
  }
  /** Enables the Network domain on every tab session, now and for later OOPIFs. */
  async enable(): Promise<void> {
    this.wanted = true;
    for (const session of this.configured) if (!session.closed) await this.enableSession(session);
  }
  private enableSession(session: Session): Promise<void> {
    const existing = this.enabled.get(session);
    if (existing) return existing;
    const setup = (async () => {
      await session.send('Network.enable');
      if (Object.keys(this.headers).length)
        await session.send('Network.setExtraHTTPHeaders', { headers: this.headers });
      if (!this.cacheEnabled)
        await session.send('Network.setCacheDisabled', { cacheDisabled: true });
      if (this.offline)
        await session.send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
    })();
    this.enabled.set(session, setup);
    void setup.catch(() => {
      if (this.enabled.get(session) === setup) this.enabled.delete(session);
    });
    return setup;
  }
  private async enableFetch(session: Session): Promise<void> {
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*' }],
      handleAuthRequests: !!this.credentials,
    });
  }
  async route(
    pattern: RegExp,
    handler: (route: Route) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    const item = { pattern, handler };
    this.routes.push(item);
    for (const session of this.configured) if (!session.closed) await this.enableFetch(session);
    return async () => {
      this.routes = this.routes.filter((r) => r !== item);
      if (!this.routes.length && !this.credentials)
        for (const session of this.configured)
          if (!session.closed) await session.send('Fetch.disable');
    };
  }
  async authenticate(credentials?: { username: string; password: string }): Promise<void> {
    this.credentials = credentials;
    this.authAttempts.clear();
    for (const session of this.configured)
      if (!session.closed) {
        if (credentials || this.routes.length) await this.enableFetch(session);
        else await session.send('Fetch.disable');
      }
  }
  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    this.headers = { ...headers };
    if (!this.wanted && Object.keys(headers).length) return this.enable();
    if (!this.wanted) return;
    await this.enable();
    for (const s of this.enabled.keys())
      if (!s.closed) await s.send('Network.setExtraHTTPHeaders', { headers });
  }
  async setCacheEnabled(enabled: boolean): Promise<void> {
    this.cacheEnabled = enabled;
    if (!this.wanted && !enabled) return this.enable();
    if (!this.wanted) return;
    await this.enable();
    for (const s of this.enabled.keys())
      if (!s.closed) await s.send('Network.setCacheDisabled', { cacheDisabled: !enabled });
  }
  async setOffline(offline: boolean): Promise<void> {
    this.offline = offline;
    if (!this.wanted && offline) return this.enable();
    if (!this.wanted) return;
    await this.enable();
    for (const s of this.enabled.keys())
      if (!s.closed)
        await s.send('Network.emulateNetworkConditions', {
          offline,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        });
  }
  waitForResponse(
    predicate: (response: Response) => boolean,
    options: WaitOptions = {},
  ): Promise<Response> {
    // Browser response events are registered before callers initiate an action.
    return this.tab.waitEvent(this.responses, predicate, options, 'network response');
  }
  dispose(): void {
    this.responses.clear();
    this.configured.clear();
    this.enabled.clear();
    this.authAttempts.clear();
  }
}
