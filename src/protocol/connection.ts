import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import type { Transport } from '../transport/transport.js';
import { DisconnectedError, ProtocolError, TimeoutError } from '../errors.js';
import { abortReason, EventHub, timeoutValue, type Listener, type WaitOptions } from '../utils.js';
export type Command = keyof ProtocolMapping.Commands;
export type Event = keyof ProtocolMapping.Events;
export type Params<M extends Command> = ProtocolMapping.Commands[M]['paramsType'];
export type Result<M extends Command> = ProtocolMapping.Commands[M]['returnType'];
export type EventParams<E extends Event> = ProtocolMapping.Events[E][0];
export interface CdpEvent {
  method: string;
  params: unknown;
  sessionId?: string;
}
/** One traced CDP command. Parameters and results are never recorded. */
export interface TraceEntry {
  method: string;
  sessionId?: string;
  durationMs: number;
  error?: string;
}
export interface ConnectionOptions {
  timeout?: number;
  onError?: (error: unknown) => void;
  /**
   * Command tracing: true writes one line per command to stderr; a function receives entries.
   * Defaults to on when the NODRIVER_TRACE environment variable is "1" or "true".
   */
  trace?: boolean | ((entry: TraceEntry) => void);
}
function tracer(option: ConnectionOptions['trace']): ((entry: TraceEntry) => void) | undefined {
  const enabled = option ?? /^(1|true)$/i.test(process.env.NODRIVER_TRACE ?? '');
  if (typeof enabled === 'function') return enabled;
  if (!enabled) return undefined;
  return (e) =>
    process.stderr.write(
      `[cdp] ${e.durationMs.toFixed(1)}ms ${e.method}${e.sessionId ? ` session=${e.sessionId.slice(0, 8)}` : ''}${e.error ? ` error=${e.error}` : ''}\n`,
    );
}
interface Route {
  method?: string;
  listener: Listener<CdpEvent>;
}
interface Pending {
  method: string;
  sessionId?: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  cleanup: () => void;
}
export class Connection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, Session>();
  private sessionParents = new Map<string, string>();
  /** Per-session listeners in registration order, so dispatch cost tracks one session only. */
  private routes = new Map<string, Set<Route>>();
  private readonly trace?: (entry: TraceEntry) => void;
  private failure?: Error;
  readonly events: EventHub<CdpEvent>;
  readonly disconnected: EventHub<Error>;
  readonly root: Session;
  readonly timeout: number;
  constructor(
    readonly transport: Transport,
    readonly options: ConnectionOptions = {},
  ) {
    this.timeout = timeoutValue(options.timeout ?? 30_000);
    this.events = new EventHub(options.onError);
    this.disconnected = new EventHub(options.onError);
    this.root = new Session(this);
    this.trace = tracer(options.trace);
    transport.onmessage = (message) => this.receive(message);
    transport.onclose = (reason) => this.finish(reason);
  }
  get closed(): boolean {
    return !!this.failure;
  }
  get pendingCount(): number {
    return this.pending.size;
  }
  /** Global plus per-session event listeners; used for leak checks. */
  get listenerCount(): number {
    let count = this.events.size;
    for (const routes of this.routes.values()) count += routes.size;
    return count;
  }
  /** Subscribes to events of one session; with a method, only that event. */
  subscribe(
    sessionId: string | undefined,
    method: string | undefined,
    listener: Listener<CdpEvent>,
  ): () => void {
    const key = sessionId ?? '';
    let routes = this.routes.get(key);
    if (!routes) this.routes.set(key, (routes = new Set()));
    const route = { method, listener };
    routes.add(route);
    return () => {
      const current = this.routes.get(key);
      if (!current?.delete(route)) return;
      if (!current.size) this.routes.delete(key);
    };
  }
  /** Delivers an event to its session's listeners, then to global listeners. */
  dispatch(event: CdpEvent): void {
    const routes = this.routes.get(event.sessionId ?? '');
    if (routes)
      for (const route of [...routes])
        if (route.method === undefined || route.method === event.method)
          try {
            const result = route.listener(event);
            if (result) void result.catch((e) => this.reportError(e));
          } catch (e) {
            this.reportError(e);
          }
    this.events.emit(event);
  }
  private reportError(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {}
  }
  session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) {
      session = new Session(this, id);
      this.sessions.set(id, session);
    }
    return session;
  }
  request<M extends Command>(
    sessionId: string | undefined,
    method: M,
    params: Params<M>,
    options: WaitOptions = {},
  ): Promise<Result<M>> {
    if (this.failure) return Promise.reject(this.failure);
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const timeout = timeoutValue(options.timeout ?? this.timeout);
    const id = ++this.nextId;
    const trace = this.trace;
    const started = trace ? performance.now() : 0;
    const record = trace
      ? (error?: Error) => {
          try {
            trace({
              method,
              sessionId,
              durationMs: performance.now() - started,
              error: error && (error instanceof ProtocolError ? `${error.code}` : error.name),
            });
          } catch {}
        }
      : undefined;
    const pending = new Promise<Result<M>>((resolve, reject) => {
      const cancel = (error: Error) => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.cleanup();
          reject(error);
        }
      };
      const abort = () => cancel(abortReason(options.signal!));
      const timer = setTimeout(
        () => cancel(new TimeoutError(`${method} timed out after ${timeout}ms`)),
        timeout,
      );
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      this.pending.set(id, {
        method,
        sessionId,
        resolve: resolve as (v: unknown) => void,
        reject,
        cleanup,
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        const sent = this.transport.send(
          JSON.stringify({ id, method, params: params[0], sessionId }),
        );
        if (sent)
          void sent.catch((e) => cancel(e instanceof Error ? e : new DisconnectedError(String(e))));
      } catch (e) {
        cancel(e as Error);
      }
    });
    if (record) void pending.then(() => record(), record);
    return pending;
  }
  private receive(message: string): void {
    if (this.failure) return;
    try {
      const m = JSON.parse(message) as {
        id?: number;
        sessionId?: string;
        result?: unknown;
        error?: { code: number; message: string; data?: string };
        method?: string;
        params?: unknown;
      };
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        // Chrome answers a command for an already-detached session at browser level (no
        // sessionId, "Session with given id not found"); fail that command, not the connection.
        const detached = p.sessionId !== undefined && m.sessionId === undefined && !!m.error;
        if (p.sessionId !== m.sessionId && !detached) {
          this.finish(new DisconnectedError('CDP response session mismatch'));
          void this.transport.close();
          return;
        }
        this.pending.delete(m.id);
        p.cleanup();
        if (detached)
          p.reject(new DisconnectedError(`Session detached: ${p.sessionId} (${m.error!.message})`));
        else if (m.error)
          p.reject(new ProtocolError(p.method, m.error.code, m.error.message, m.error.data));
        else p.resolve(m.result ?? {});
      } else if (typeof m.method === 'string') {
        if (m.method === 'Target.attachedToTarget' && m.sessionId) {
          if (!this.sessions.has(m.sessionId)) return;
          this.sessionParents.set((m.params as { sessionId: string }).sessionId, m.sessionId);
        }
        if (m.method === 'Target.detachedFromTarget') {
          const id = (m.params as { sessionId: string }).sessionId;
          this.detach(id, new DisconnectedError(`Session detached: ${id}`));
        }
        this.dispatch({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
      } else throw new Error('Invalid CDP message');
    } catch (e) {
      this.finish(new DisconnectedError(`Malformed CDP message: ${String(e)}`));
      void this.transport.close();
    }
  }
  detach(id: string, reason = new DisconnectedError('Session detached')): void {
    // Parent detach can suppress descendant detach events (notably BFCache
    // OOPIFs when their tab/context closes). Retire the whole ownership tree.
    this.sessionParents.delete(id);
    for (const [child, parent] of this.sessionParents)
      if (parent === id) this.detach(child, reason);
    for (const [key, p] of this.pending)
      if (p.sessionId === id) {
        this.pending.delete(key);
        p.cleanup();
        p.reject(reason);
      }
    this.sessions.get(id)?.invalidate(reason);
    this.sessions.delete(id);
    this.routes.delete(id);
  }
  private finish(reason: Error): void {
    if (this.failure) return;
    this.failure = reason;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(reason);
    }
    this.pending.clear();
    this.root.invalidate(reason);
    for (const s of this.sessions.values()) s.invalidate(reason);
    this.sessions.clear();
    this.sessionParents.clear();
    this.disconnected.emit(reason);
    this.disconnected.clear();
    this.events.clear();
    this.routes.clear();
  }
  async close(): Promise<void> {
    this.finish(new DisconnectedError('Connection closed by client'));
    await this.transport.close();
  }
}
export class Session {
  private failure?: Error;
  private readonly subscriptions = new Set<() => void>();
  readonly disconnected = new EventHub<Error>();
  constructor(
    readonly connection: Connection,
    readonly id?: string,
  ) {}
  get closed(): boolean {
    return !!this.failure || this.connection.closed;
  }
  send<M extends Command>(method: M, ...params: Params<M>): Promise<Result<M>> {
    return this.sendWith(method, {}, ...params);
  }
  sendWith<M extends Command>(
    method: M,
    options: WaitOptions,
    ...params: Params<M>
  ): Promise<Result<M>> {
    if (this.failure) return Promise.reject(this.failure);
    return this.connection.request(this.id, method, params, options);
  }
  on<E extends Event>(method: E, listener: Listener<EventParams<E>>): () => void {
    if (this.closed) throw this.failure ?? new DisconnectedError('Session closed');
    const off = this.connection.subscribe(this.id, method, (e) =>
      listener(e.params as EventParams<E>),
    );
    const dispose = () => {
      off();
      this.subscriptions.delete(dispose);
    };
    this.subscriptions.add(dispose);
    return dispose;
  }
  /** Subscribes to every event of this session, in registration order with on(). */
  onAny(listener: Listener<CdpEvent>): () => void {
    if (this.closed) throw this.failure ?? new DisconnectedError('Session closed');
    const off = this.connection.subscribe(this.id, undefined, listener);
    const dispose = () => {
      off();
      this.subscriptions.delete(dispose);
    };
    this.subscriptions.add(dispose);
    return dispose;
  }
  waitFor<E extends Event>(
    method: E,
    predicate: (event: EventParams<E>) => boolean = () => true,
    options: WaitOptions = {},
  ): Promise<EventParams<E>> {
    if (this.closed) return Promise.reject(this.failure ?? new DisconnectedError('Session closed'));
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    return new Promise((resolve, reject) => {
      const timeout = timeoutValue(options.timeout ?? this.connection.timeout);
      const cleanup = () => {
        clearTimeout(timer);
        off();
        offClose();
        options.signal?.removeEventListener('abort', abort);
      };
      const fail = (e: Error) => {
        cleanup();
        reject(e);
      };
      const abort = () => fail(abortReason(options.signal!));
      const off = this.on(method, (e) => {
        try {
          if (predicate(e)) {
            cleanup();
            resolve(e);
          }
        } catch (e) {
          fail(e as Error);
        }
      });
      const offClose = this.disconnected.on(fail);
      const timer = setTimeout(
        () => fail(new TimeoutError(`Timed out waiting for ${method}`)),
        timeout,
      );
      options.signal?.addEventListener('abort', abort, { once: true });
    });
  }
  invalidate(reason: Error): void {
    if (this.failure) return;
    this.failure = reason;
    this.disconnected.emit(reason);
    this.disconnected.clear();
    for (const off of this.subscriptions) off();
    this.subscriptions.clear();
  }
}
