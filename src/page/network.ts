import type { Protocol } from 'devtools-protocol';
import type { Session } from '../protocol/connection.ts';
import type { Tab } from './tab.ts';
import { EventHub, type WaitOptions } from '../utils.ts';
import { DisconnectedError, NodriverError, ProtocolError } from '../errors.ts';
/**
 * Chrome no longer holds this paused request: the page cancelled it, its frame went away, or
 * Fetch.disable released it. No answer is possible or needed.
 */
const requestGone = (error: unknown): boolean =>
  error instanceof ProtocolError &&
  /Invalid InterceptionId|Fetch domain is not enabled/.test(error.message);
/** A session that ended during a command needs nothing further from it. */
const sessionGone = (session: Session, error: unknown): boolean =>
  session.closed || error instanceof DisconnectedError;
/** A stateless private copy. `y` would anchor every test at index 0, so the source does that. */
function matcher(pattern: RegExp): RegExp {
  const source = pattern.sticky ? `^(?:${pattern.source})` : pattern.source;
  return new RegExp(source, pattern.flags.replace(/[gy]/g, ''));
}
export class Route {
  private handled = false;
  readonly session: Session;
  readonly request: Protocol.Fetch.RequestPausedEvent;
  constructor(session: Session, request: Protocol.Fetch.RequestPausedEvent) {
    this.session = session;
    this.request = request;
  }
  get done(): boolean {
    return this.handled;
  }
  /** A command Chrome refuses leaves the request paused, so the route can be answered again. */
  private async answer(send: () => Promise<unknown>): Promise<void> {
    if (this.handled) throw new NodriverError('Route already handled');
    this.handled = true;
    try {
      await send();
    } catch (error) {
      if (requestGone(error)) return;
      if (error instanceof ProtocolError) this.handled = false;
      throw error;
    }
  }
  async continue(
    overrides: Omit<Protocol.Fetch.ContinueRequestRequest, 'requestId'> = {},
  ): Promise<void> {
    await this.answer(() =>
      this.session.send('Fetch.continueRequest', {
        ...overrides,
        requestId: this.request.requestId,
      }),
    );
  }
  async abort(reason: Protocol.Network.ErrorReason = 'Aborted'): Promise<void> {
    await this.answer(() =>
      this.session.send('Fetch.failRequest', {
        requestId: this.request.requestId,
        errorReason: reason,
      }),
    );
  }
  async fulfill(options: {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Uint8Array;
  }): Promise<void> {
    await this.answer(() =>
      this.session.send('Fetch.fulfillRequest', {
        requestId: this.request.requestId,
        responseCode: options.status ?? 200,
        responseHeaders: Object.entries(options.headers ?? {}).map(([name, value]) => ({
          name,
          value,
        })),
        body: Buffer.from(options.body ?? '').toString('base64'),
      }),
    );
  }
}
export interface Response {
  event: Protocol.Network.ResponseReceivedEvent;
  body(): Promise<Buffer>;
}
/** An event hub that runs a hook whenever a listener subscribes. */
class LazyHub<T> extends EventHub<T> {
  private readonly subscribed: () => void;
  constructor(subscribed: () => void) {
    super();
    this.subscribed = subscribed;
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
    // Sends nothing once enabled; each subscription retries a setup that failed.
    void this.enable().catch((e) => this.tab.reportError(e));
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
  private tab: Tab;
  constructor(tab: Tab) {
    this.tab = tab;
  }
  async configure(session: Session): Promise<void> {
    if (session.closed || this.configured.has(session)) return;
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
        const match = this.routes.find((r) => r.pattern.test(event.request.url));
        if (match) await match.handler(route);
        if (!route.done) await route.continue();
      } catch (e) {
        // A request paused while its tab closes cannot be answered; that is not an error.
        if (!session.closed) this.tab.reportError(e);
        if (!route.done) await route.abort().catch(() => {});
      }
    });
    session.on('Fetch.authRequired', async (event) => {
      const key = `${session.id}:${event.requestId}`;
      const tried = this.authAttempts.has(key);
      this.authAttempts.add(key);
      if (this.authAttempts.size > 1024)
        this.authAttempts.delete(this.authAttempts.values().next().value!);
      try {
        await session.send('Fetch.continueWithAuth', {
          requestId: event.requestId,
          authChallengeResponse:
            this.credentials && !tried
              ? { response: 'ProvideCredentials', ...this.credentials }
              : { response: 'CancelAuth' },
        });
      } catch (e) {
        // A challenge pending while its tab closes cannot be answered; that is not an error.
        if (!session.closed && !requestGone(e)) throw e;
      }
    });
    // Independent steps: a refusal must not cost the session the rest of its setup, including
    // the environment and init scripts Tab.configureSession applies next.
    const report = (error: unknown) => {
      if (!sessionGone(session, error)) this.tab.reportError(error);
    };
    if (this.wanted) await this.enableSession(session).catch(report);
    if (this.routes.length || this.credentials) await this.updateFetch(session).catch(report);
  }
  get networkEnabled(): boolean {
    return this.wanted;
  }
  /** Enables the Network domain on every tab session, now and for later OOPIFs. */
  async enable(): Promise<void> {
    await this.enableEach();
  }
  /** Runs `step` on each live session in turn, including sessions that join meanwhile. */
  private async eachSession(
    step: (session: Session) => Promise<unknown>,
    fail: (error: unknown) => void = (error) => {
      throw error;
    },
  ): Promise<void> {
    for (const session of this.configured)
      if (!session.closed)
        await step(session).catch((error: unknown) => {
          if (!sessionGone(session, error)) fail(error);
        });
  }
  /** Enables each session, then runs `step` on it. The next call retries whatever failed. */
  private async enableEach(step?: (session: Session) => Promise<unknown>): Promise<void> {
    const first = !this.wanted;
    this.wanted = true;
    try {
      await this.eachSession(async (session) => {
        await this.enableSession(session);
        await step?.(session);
      });
    } catch (error) {
      // A first request that enabled nothing leaves the domain off; an earlier one still stands.
      if (first && !this.enabled.size) this.wanted = false;
      throw error;
    }
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
  /** Reads the state at send time, so concurrent changes settle on the latest one. */
  private updateFetch(session: Session): Promise<unknown> {
    return this.routes.length || this.credentials
      ? session.send('Fetch.enable', {
          patterns: [{ urlPattern: '*' }],
          handleAuthRequests: !!this.credentials,
        })
      : session.send('Fetch.disable');
  }
  /** Applies a Fetch state change to each session; a refused change is undone on all of them. */
  private async applyFetch(undo: () => void): Promise<void> {
    try {
      await this.eachSession((s) => this.updateFetch(s));
    } catch (error) {
      undo();
      await this.eachSession(
        (s) => this.updateFetch(s),
        (e) => this.tab.reportError(e),
      );
      throw error;
    }
  }
  route(
    pattern: RegExp,
    handler: (route: Route) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    return this.addRoute(pattern, handler, false);
  }
  /** @internal Like route(), but ahead of the caller's routes, so it sees every request first. */
  routeFirst(
    pattern: RegExp,
    handler: (route: Route) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    return this.addRoute(pattern, handler, true);
  }
  private async addRoute(
    pattern: RegExp,
    handler: (route: Route) => Promise<void> | void,
    first: boolean,
  ): Promise<() => Promise<void>> {
    const item = { pattern: matcher(pattern), handler };
    const remove = () => {
      this.routes = this.routes.filter((r) => r !== item);
    };
    if (first) this.routes.unshift(item);
    else this.routes.push(item);
    await this.applyFetch(remove);
    return async () => {
      remove();
      if (!this.routes.length && !this.credentials)
        await this.eachSession((s) => this.updateFetch(s));
    };
  }
  async authenticate(credentials?: { username: string; password: string }): Promise<void> {
    const previous = this.credentials;
    this.credentials = credentials;
    this.authAttempts.clear();
    await this.applyFetch(() => {
      this.credentials = previous;
    });
  }
  async setExtraHeaders(headers: Record<string, string>): Promise<void> {
    const next = { ...headers };
    // Chrome sends values as UTF-8 bytes, so check those: `Headers` refuses non-Latin-1 text.
    new Headers(
      Object.entries(next).map(([name, value]): [string, string] => [
        name,
        Buffer.from(value).toString('latin1'),
      ]),
    );
    if (this.wanted || Object.keys(next).length)
      await this.enableEach((s) => s.send('Network.setExtraHTTPHeaders', { headers: next }));
    this.headers = next;
  }
  async setCacheEnabled(enabled: boolean): Promise<void> {
    if (this.wanted || !enabled)
      await this.enableEach((s) => s.send('Network.setCacheDisabled', { cacheDisabled: !enabled }));
    this.cacheEnabled = enabled;
  }
  async setOffline(offline: boolean): Promise<void> {
    if (this.wanted || offline)
      await this.enableEach((s) =>
        s.send('Network.emulateNetworkConditions', {
          offline,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        }),
      );
    this.offline = offline;
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
