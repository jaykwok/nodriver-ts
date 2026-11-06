import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import type { Transport } from '../transport/transport.ts';
import { DisconnectedError, ProtocolError, TimeoutError } from '../errors.ts';
import { abortReason, EventHub, timeoutValue, type Listener, type WaitOptions } from '../utils.ts';
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
export type EndReason =
  'detach-requested' | 'detached' | 'target-destroyed' | 'target-crashed' | 'disconnected';
export class SessionEndedError extends DisconnectedError {
  override name = 'SessionEndedError';
  readonly reason: EndReason;
  readonly targetId: string;
  constructor(reason: EndReason, targetId: string, options?: ErrorOptions) {
    super(`Target session ended: ${reason} (${targetId})`, options);
    this.reason = reason;
    this.targetId = targetId;
  }
}
/** Chrome's reply when an attachment no longer exists: it detached, or its target closed. */
function attachmentGone(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    /session.*(not found|not exist)|no session/i.test(error.message)
  );
}
export interface ConnectionObserver {
  /** Synchronous transport-send observation. at is performance.now(), not wall-clock time. */
  onSend?(event: { seq: number; method: string; sessionId?: string; at: number }): void;
  /** Caller settlement, once per send attempt; cancellation/timeout does not imply a response. */
  onSettle?(event: { seq: number; durationMs: number; error?: string }): void;
  /** Correlated wire response, including replies after caller settlement. No payloads are exposed. */
  onResponse?(event: ResponseObservation): void;
  /** Opt-in phase timings and UTF-8 message sizes; no payload retention or extra JSON parse. */
  onPerformance?(event: PerformanceObservation): void;
}
export type PerformanceObservation =
  | {
      direction: 'send';
      seq: number;
      method: string;
      sessionId?: string;
      at: number;
      bytes: number;
      queueMs: number;
      serializationMs: number;
    }
  | {
      direction: 'receive';
      kind: 'response' | 'event' | 'invalid';
      at: number;
      bytes: number;
      parseMs: number;
      dispatchMs: number;
      /** Present only for a correlated response (including late responses). */
      seq?: number;
      method?: string;
      sessionId?: string;
      responseWaitMs?: number;
    };
export interface ResponseObservation {
  /** The CDP request ID, identical to onSend/onSettle.seq, scoped to this connection. */
  seq: number;
  method: string;
  /** The request's session ID (a detached-session error may arrive at browser level). */
  sessionId?: string;
  /** Receive time, using performance.now(). */
  at: number;
  /** Elapsed time from the send attempt to receipt, not caller settlement. */
  durationMs: number;
  /** True if the caller's request was already retired before this response arrived. */
  late: boolean;
  /** CDP error code only; error messages, data and response payloads are omitted. */
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
  observe?: ConnectionObserver;
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
  hooks?: RequestHooks;
  /** The owner that recorded this request, inherited by cleanup it causes. */
  recorder?: RequestRecorder;
}
interface RequestHooks {
  targetId: string;
  accept: (result: unknown) => void;
}
interface Unanswered {
  method: string;
  sessionId?: string;
  at: number;
  transportAt?: number;
  /** The session detached; Chrome never answers a detached session's requests. */
  detached?: boolean;
}
const ATTACH_CLEANUP_TIMEOUT = 5000;
/** @internal Receives the ID of each request a connection creates for its owner, and its session. */
export type RequestRecorder = (connection: Connection, id: number, session?: Session) => void;
/** @internal Options key: records the ID of the request sent with these options. */
export const REQUEST_LEDGER = Symbol('nodriver.requestLedger');
/** @internal */
export type LedgerOptions = WaitOptions & { [REQUEST_LEDGER]?: RequestRecorder };
/** @internal Records requests sent within an async context, such as an input action. */
export const requestLedger = new AsyncLocalStorage<RequestRecorder>();
export class Connection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  private unanswered = new Map<number, Unanswered>();
  /** Requests that were awaiting settlement or a reply when the connection closed. */
  private lost = new Set<number>();
  private sessions = new Map<string, Session>();
  private sessionParents = new Map<string, string>();
  /** Target type of each attachment, for errors. */
  private targetTypes = new Map<string, string>();
  private abandoned = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; recorder?: RequestRecorder }
  >();
  private attachingIds = new Map<string, EndReason | undefined>();
  private sendQueue: Array<() => void> = [];
  private sending = false;
  private cleanupCount = 0;
  private settlingCount = 0;
  private readonly drainWaiters = new Set<() => void>();
  private drainScheduled = false;
  /** Per-session listeners in registration order, so dispatch cost tracks one session only. */
  private routes = new Map<string, Set<Route>>();
  private readonly trace?: (entry: TraceEntry) => void;
  private failure?: Error;
  readonly events: EventHub<CdpEvent>;
  readonly disconnected: EventHub<Error>;
  readonly root: Session;
  readonly timeout: number;
  readonly transport: Transport;
  readonly options: ConnectionOptions;
  constructor(transport: Transport, options: ConnectionOptions = {}) {
    this.transport = transport;
    this.options = options;
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
  /** The error that closed this connection, once closed. */
  get closeReason(): Error | undefined {
    return this.failure;
  }
  /** Requests still awaiting caller settlement, including queued sends. */
  get pendingCount(): number {
    return this.pending.size;
  }
  /**
   * Send attempts without a correlated response. Cancellation, timeout, session end and send
   * errors do not erase this debt; only a response or connection closure does. Zero on a closed
   * connection is not evidence of successful responses or completion of browser-side work.
   */
  get unansweredCount(): number {
    return this.unanswered.size;
  }
  /**
   * Wait for caller requests, wire replies and library attachment cleanup. Rejects on
   * disconnect/timeout/abort; never retries commands or closes the connection itself.
   * Stop producers first: this is a quiescence check, not a lock against future sends.
   */
  drain(options: WaitOptions = {}): Promise<void> {
    return this.waitIdle(
      () =>
        !this.pending.size &&
        !this.unanswered.size &&
        !this.abandoned.size &&
        !this.cleanupCount &&
        !this.settlingCount &&
        !this.sending &&
        !this.sendQueue.length,
      options,
    );
  }
  /**
   * @internal Like drain(), but waits only until each of the ledger's requests is settled and
   * answered, or can no longer be answered because its session detached, so unrelated work on the
   * connection does not hold up the caller. Answered IDs are removed.
   */
  drainRequests(ledger: Set<number>, options: WaitOptions = {}): Promise<void> {
    return this.waitIdle(() => !this.answerable(ledger), options);
  }
  /** Whether a ledger request awaits settlement or a reply that can still arrive. */
  private answerable(ledger: Set<number>): boolean {
    if (!this.outstanding(ledger)) return false;
    for (const id of ledger) {
      if (this.pending.has(id)) return true;
      const wire = this.unanswered.get(id);
      if (wire && !wire.detached) return true;
    }
    return false;
  }
  /**
   * @internal Whether a ledger request awaits settlement or a reply; drops answered IDs. After the
   * connection closes, the requests it lost stay outstanding.
   */
  outstanding(ledger: Set<number>): boolean {
    let found = false;
    for (const id of ledger)
      if (this.pending.has(id) || this.unanswered.has(id) || this.lost.has(id)) found = true;
      else ledger.delete(id);
    return found;
  }
  /**
   * @internal Removes the ledger's requests to detached sessions, which are never answered, and
   * returns the IDs of those sessions.
   */
  unanswerable(ledger: Set<number>): Set<string> {
    const sessions = new Set<string>();
    for (const id of ledger) {
      const wire = this.unanswered.get(id);
      if (!wire?.detached) continue;
      sessions.add(wire.sessionId!);
      ledger.delete(id);
    }
    return sessions;
  }
  private waitIdle(idle: () => boolean, options: WaitOptions): Promise<void> {
    const timeout = timeoutValue(options.timeout ?? this.timeout);
    if (this.failure) return Promise.reject(this.drainFailure());
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    return new Promise((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        this.drainWaiters.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (this.failure) finish(this.drainFailure());
        else if (idle()) finish();
      };
      const abort = () => finish(abortReason(options.signal!));
      const timer = setTimeout(
        () => finish(new TimeoutError(`CDP drain timed out after ${timeout}ms`)),
        timeout,
      );
      this.drainWaiters.add(check);
      options.signal?.addEventListener('abort', abort, { once: true });
      this.notifyDrain();
    });
  }
  private drainFailure(): DisconnectedError {
    return new DisconnectedError('CDP disconnected before drain completed', {
      cause: this.failure,
    });
  }
  private notifyDrain(): void {
    if (!this.drainWaiters.size || this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      for (const check of this.drainWaiters) check();
    });
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
  /** @internal Used by Browser.attachSession; no page initialization or deduplication. */
  attachSession(targetId: string, options: WaitOptions = {}): Promise<TargetSession> {
    let session: TargetSession;
    return this.requestCommand(
      undefined,
      'Target.attachToTarget',
      [{ targetId, flatten: true }],
      options,
      {
        targetId,
        accept: (result) => {
          const id = (result as { sessionId?: string }).sessionId;
          if (!id) throw new DisconnectedError('Attach response has no sessionId');
          const ended = this.attachingIds.get(id);
          this.attachingIds.delete(id);
          if (ended) throw new SessionEndedError(ended, targetId);
          session = new TargetSession(this, id, targetId);
          // A root listener may have made a plain Session for this attachment; events now go here.
          this.sessions
            .get(id)
            ?.invalidate(new DisconnectedError(`Session ${id} was replaced by attachSession()`));
          this.sessions.set(id, session);
        },
      },
    ).then(() => session);
  }
  /** @internal Cleanup has its own deadline and never uses the cancelled operation signal. */
  async cleanupAttachment(id: string): Promise<void> {
    if (this.closed) return;
    this.cleanupCount++;
    try {
      await this.root.sendWith(
        'Target.detachFromTarget',
        { timeout: ATTACH_CLEANUP_TIMEOUT },
        { sessionId: id },
      );
    } catch (error) {
      // A missing attachment is already clean. Other failures cannot establish ownership.
      if (attachmentGone(error)) return;
      if (!this.closed) {
        this.reportError(error);
        await this.close();
      }
    } finally {
      this.cleanupCount--;
      this.notifyDrain();
    }
  }
  /** @internal Track the continuation that may start independent detach cleanup. */
  async detachAttachment(id: string, options: WaitOptions): Promise<void> {
    this.cleanupCount++;
    try {
      await this.root.sendWith('Target.detachFromTarget', options, { sessionId: id });
    } catch (error) {
      // A missing attachment is already detached.
      if (attachmentGone(error)) return;
      void this.cleanupAttachment(id);
      throw error;
    } finally {
      this.cleanupCount--;
      this.notifyDrain();
    }
  }
  request<M extends Command>(
    sessionId: string | undefined,
    method: M,
    params: Params<M>,
    options: WaitOptions = {},
  ): Promise<Result<M>> {
    return this.requestCommand(sessionId, method, params, options);
  }
  private requestCommand<M extends Command>(
    sessionId: string | undefined,
    method: M,
    params: Params<M>,
    options: WaitOptions,
    hooks?: RequestHooks,
  ): Promise<Result<M>> {
    if (this.failure) return Promise.reject(this.failure);
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const timeout = timeoutValue(options.timeout ?? this.timeout);
    const id = ++this.nextId;
    const recorder = (options as LedgerOptions)[REQUEST_LEDGER] ?? requestLedger.getStore();
    recorder?.(this, id, sessionId === undefined ? undefined : this.sessions.get(sessionId));
    const trace = this.trace;
    const observer = this.options.observe;
    const metrics = observer?.onPerformance;
    const queuedAt = metrics ? performance.now() : 0;
    let started = performance.now();
    let sentOnWire = false;
    const record =
      trace || observer?.onSettle
        ? (error?: Error) => {
            const durationMs = performance.now() - started;
            const code = error && (error instanceof ProtocolError ? `${error.code}` : error.name);
            try {
              trace?.({
                method,
                sessionId,
                durationMs,
                error: code,
              });
            } catch {}
            if (sentOnWire) {
              try {
                observer?.onSettle?.({ seq: id, durationMs, error: code });
              } catch {}
            }
          }
        : undefined;
    const pending = new Promise<Result<M>>((resolve, reject) => {
      const cancel = (error: Error) => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.cleanup();
          if (hooks && sentOnWire) this.abandonAttach(id, recorder);
          reject(error);
          this.notifyDrain();
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
        hooks,
        recorder,
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      // Queue reentrant sends made by observers so seq also describes transport invocation order.
      this.sendQueue.push(() => {
        if (!this.pending.has(id) || this.closed) return;
        try {
          const serializingAt = metrics ? performance.now() : 0;
          const message = JSON.stringify({ id, method, params: params[0], sessionId });
          started = performance.now();
          sentOnWire = true;
          const wire: Unanswered = { method, sessionId, at: started };
          this.unanswered.set(id, wire);
          try {
            observer?.onSend?.({ seq: id, method, sessionId, at: started });
          } catch {}
          // The observer describes this send attempt. Its cancellation cannot unsend it.
          if (metrics) wire.transportAt = performance.now();
          let sent: void | Promise<void>;
          try {
            sent = this.transport.send(message);
          } finally {
            try {
              metrics?.({
                direction: 'send',
                seq: id,
                method,
                sessionId,
                at: started,
                bytes: Buffer.byteLength(message),
                queueMs: serializingAt - queuedAt,
                serializationMs: started - serializingAt,
              });
            } catch {}
          }
          if (sent)
            void sent.catch((e) =>
              cancel(e instanceof Error ? e : new DisconnectedError(String(e))),
            );
        } catch (e) {
          cancel(e as Error);
        }
      });
      if (!this.sending) {
        this.sending = true;
        try {
          while (this.sendQueue.length) this.sendQueue.shift()!();
        } finally {
          this.sending = false;
          this.notifyDrain();
        }
      }
    });
    if (record) {
      this.settlingCount++;
      const settled = (error?: Error) => {
        record(error);
        this.settlingCount--;
        this.notifyDrain();
      };
      void pending.then(() => settled(), settled);
    }
    return pending;
  }
  private abandonAttach(id: number, recorder?: RequestRecorder): void {
    if (this.closed || this.abandoned.has(id)) return;
    const timer = setTimeout(() => {
      this.abandoned.delete(id);
      this.reportError(new TimeoutError('Cancelled attach cleanup timed out; disconnecting CDP'));
      void this.close();
    }, ATTACH_CLEANUP_TIMEOUT);
    this.abandoned.set(id, { timer, recorder });
  }
  private pruneAttachingIds(): void {
    if (!this.abandoned.size && ![...this.pending.values()].some((p) => p.hooks))
      this.attachingIds.clear();
  }
  private receive(message: string): void {
    if (this.failure) return;
    const metrics = this.options.observe?.onPerformance;
    const receivedAt = metrics ? performance.now() : 0;
    let parsedAt = receivedAt;
    let metric: Extract<PerformanceObservation, { direction: 'receive' }> | undefined;
    try {
      const m = JSON.parse(message) as {
        id?: number;
        sessionId?: string;
        result?: unknown;
        error?: { code: number; message: string; data?: string };
        method?: string;
        params?: unknown;
      };
      if (metrics) {
        parsedAt = performance.now();
        metric = {
          direction: 'receive',
          kind:
            m.id !== undefined ? 'response' : typeof m.method === 'string' ? 'event' : 'invalid',
          at: receivedAt,
          bytes: 0,
          parseMs: parsedAt - receivedAt,
          dispatchMs: 0,
        };
      }
      if (m.id !== undefined) {
        const wire = this.unanswered.get(m.id);
        // Unknown IDs and duplicate responses cannot acknowledge another request.
        if (!wire) return;
        if (metric)
          Object.assign(metric, {
            seq: m.id,
            method: wire.method,
            sessionId: wire.sessionId,
            responseWaitMs:
              wire.transportAt === undefined ? undefined : receivedAt - wire.transportAt,
          });
        const p = this.pending.get(m.id);
        // Chrome may answer a detached session's command at browser level with an error.
        const detached = wire.sessionId !== undefined && m.sessionId === undefined && !!m.error;
        if (wire.sessionId !== m.sessionId && !detached) {
          this.finish(new DisconnectedError('CDP response session mismatch'));
          void this.transport.close();
          return;
        }
        const at = performance.now();
        const response: ResponseObservation = {
          seq: m.id,
          method: wire.method,
          sessionId: wire.sessionId,
          at,
          durationMs: at - wire.at,
          late: !p,
          error: m.error ? String(m.error.code) : undefined,
        };
        this.unanswered.delete(m.id);
        if (!p) {
          const abandoned = this.abandoned.get(m.id);
          if (abandoned) {
            clearTimeout(abandoned.timer);
            this.abandoned.delete(m.id);
            const id = (m.result as { sessionId?: string } | undefined)?.sessionId;
            if (id) {
              this.attachingIds.delete(id);
              // The detach belongs to whoever owned the attach; it is recorded synchronously,
              // before that owner can observe the attach reply as settled.
              const cleanup = () => this.cleanupAttachment(id);
              void (abandoned.recorder
                ? requestLedger.run(abandoned.recorder, cleanup)
                : cleanup());
            } else if (!m.error) void this.close();
            this.pruneAttachingIds();
          }
          this.observeResponse(response);
          return;
        }
        this.pending.delete(m.id);
        p.cleanup();
        if (detached)
          p.reject(new DisconnectedError(`Session detached: ${p.sessionId} (${m.error!.message})`));
        else if (m.error)
          p.reject(
            new ProtocolError(p.method, m.error.code, m.error.message, m.error.data, {
              sessionId: p.sessionId,
              targetType: p.sessionId ? this.targetTypes.get(p.sessionId) : 'browser',
            }),
          );
        else {
          try {
            p.hooks?.accept(m.result ?? {});
            p.resolve(m.result ?? {});
          } catch (error) {
            p.reject(error as Error);
            if (!(error instanceof SessionEndedError)) void this.close();
          }
        }
        this.pruneAttachingIds();
        this.observeResponse(response);
      } else if (typeof m.method === 'string') {
        if (metric) Object.assign(metric, { method: m.method, sessionId: m.sessionId });
        if (m.method === 'Target.attachedToTarget') {
          const event = m.params as { sessionId: string; targetInfo?: { type?: string } };
          if (event.targetInfo?.type) this.targetTypes.set(event.sessionId, event.targetInfo.type);
        }
        if (m.method === 'Target.attachedToTarget' && !m.sessionId) {
          const event = m.params as { sessionId: string; targetInfo: { targetId: string } };
          if (
            this.abandoned.size ||
            [...this.pending.values()].some((p) => p.hooks?.targetId === event.targetInfo.targetId)
          )
            this.attachingIds.set(event.sessionId, undefined);
        }
        if (m.method === 'Target.attachedToTarget' && m.sessionId) {
          if (!this.sessions.has(m.sessionId)) return;
          this.sessionParents.set((m.params as { sessionId: string }).sessionId, m.sessionId);
        }
        if (m.method === 'Target.detachedFromTarget') {
          const id = (m.params as { sessionId: string }).sessionId;
          if (this.attachingIds.has(id)) this.attachingIds.set(id, 'detached');
          this.detach(id, new DisconnectedError(`Session detached: ${id}`));
        }
        if (m.method === 'Target.targetDestroyed' || m.method === 'Target.targetCrashed') {
          const targetId = (m.params as { targetId: string }).targetId;
          const reason =
            m.method === 'Target.targetDestroyed' ? 'target-destroyed' : 'target-crashed';
          for (const [id, pending] of this.pending)
            if (pending.hooks?.targetId === targetId) {
              this.pending.delete(id);
              pending.cleanup();
              // An attach still queued is never sent, and never answered.
              if (this.unanswered.has(id)) this.abandonAttach(id, pending.recorder);
              pending.reject(new SessionEndedError(reason, targetId));
            }
          for (const session of [...this.sessions.values()])
            if (session instanceof TargetSession && session.targetId === targetId)
              session.end(reason);
        }
        if (m.method === 'Inspector.targetCrashed' && m.sessionId) {
          const session = this.sessions.get(m.sessionId);
          if (session instanceof TargetSession) session.end('target-crashed');
        }
        this.dispatch({ method: m.method, params: m.params ?? {}, sessionId: m.sessionId });
      } else throw new Error('Invalid CDP message');
    } catch (e) {
      if (metrics && !metric) {
        parsedAt = performance.now();
        metric = {
          direction: 'receive',
          kind: 'invalid',
          at: receivedAt,
          bytes: 0,
          parseMs: parsedAt - receivedAt,
          dispatchMs: 0,
        };
      }
      this.finish(new DisconnectedError(`Malformed CDP message: ${String(e)}`, { cause: e }));
      void this.transport.close();
    } finally {
      if (metrics) {
        const finishedAt = performance.now();
        metric ??= {
          direction: 'receive',
          kind: 'invalid',
          at: receivedAt,
          bytes: 0,
          parseMs: finishedAt - receivedAt,
          dispatchMs: 0,
        };
        metric.bytes = Buffer.byteLength(message);
        metric.dispatchMs = finishedAt - parsedAt;
        try {
          metrics(metric);
        } catch {}
      }
      this.notifyDrain();
    }
  }
  private observeResponse(event: ResponseObservation): void {
    // Update protocol state and schedule abandoned-attach cleanup before notifying user code.
    try {
      this.options.observe?.onResponse?.(event);
    } catch {}
  }
  detach(id: string, reason = new DisconnectedError('Session detached')): void {
    const session = this.sessions.get(id);
    if (session instanceof TargetSession && !(reason instanceof SessionEndedError))
      reason = new SessionEndedError('detached', session.targetId, { cause: reason });
    // Parent detach can suppress descendant detach events (notably BFCache
    // OOPIFs when their tab/context closes). Retire the whole ownership tree.
    this.sessionParents.delete(id);
    this.targetTypes.delete(id);
    for (const [child, parent] of this.sessionParents)
      if (parent === id) this.detach(child, reason);
    for (const [key, p] of this.pending)
      if (p.sessionId === id) {
        this.pending.delete(key);
        p.cleanup();
        p.reject(reason);
      }
    for (const wire of this.unanswered.values()) if (wire.sessionId === id) wire.detached = true;
    session?.invalidate(reason);
    this.sessions.delete(id);
    this.routes.delete(id);
    this.notifyDrain();
  }
  private finish(reason: Error): void {
    if (this.failure) return;
    this.failure = reason;
    for (const p of this.pending.values()) {
      p.cleanup();
      const session = p.sessionId && this.sessions.get(p.sessionId);
      p.reject(
        session instanceof TargetSession
          ? new SessionEndedError('disconnected', session.targetId, { cause: reason })
          : reason,
      );
    }
    for (const id of this.pending.keys()) this.lost.add(id);
    for (const id of this.unanswered.keys()) this.lost.add(id);
    this.pending.clear();
    this.unanswered.clear();
    for (const { timer } of this.abandoned.values()) clearTimeout(timer);
    this.abandoned.clear();
    this.attachingIds.clear();
    this.root.invalidate(reason);
    for (const s of this.sessions.values()) s.invalidate(reason);
    this.sessions.clear();
    this.sessionParents.clear();
    this.targetTypes.clear();
    this.disconnected.emit(reason);
    this.disconnected.clear();
    this.events.clear();
    this.routes.clear();
    this.notifyDrain();
  }
  async close(): Promise<void> {
    this.finish(new DisconnectedError('Connection closed by client'));
    await this.transport.close();
  }
}
export class Session {
  private failure?: Error;
  private readonly subscriptions = new Set<() => void>();
  readonly disconnected: EventHub<Error>;
  readonly connection: Connection;
  readonly id?: string;
  constructor(connection: Connection, id?: string) {
    this.connection = connection;
    this.id = id;
    this.disconnected = new EventHub<Error>(connection.options.onError);
  }
  get closed(): boolean {
    return !!this.failure || this.connection.closed;
  }
  /** The error that ended this session or its connection, once closed. */
  get closeReason(): Error | undefined {
    return this.failure ?? this.connection.closeReason;
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

/** One explicit raw attachment. Crash ends this logical lifetime; recovery requires a new one. */
export class TargetSession extends Session {
  readonly targetId: string;
  private reason?: EndReason;
  private resolveEnded!: (reason: EndReason) => void;
  readonly ended = new Promise<EndReason>((resolve) => {
    this.resolveEnded = resolve;
  });
  private detaching?: Promise<void>;
  constructor(connection: Connection, id: string, targetId: string) {
    super(connection, id);
    this.targetId = targetId;
  }
  get endReason(): EndReason | undefined {
    return this.reason;
  }
  override invalidate(error: Error): void {
    if (this.reason) return;
    const ended =
      error instanceof SessionEndedError && error.targetId === this.targetId
        ? error
        : new SessionEndedError(
            error instanceof SessionEndedError ? error.reason : 'disconnected',
            this.targetId,
            { cause: error },
          );
    this.reason = ended.reason;
    super.invalidate(ended);
    this.resolveEnded(this.reason);
  }
  /** @internal */
  end(reason: EndReason): void {
    if (this.closed) return;
    const ended = new SessionEndedError(reason, this.targetId);
    this.connection.detach(this.id!, ended);
    // Also when another session object has taken over this ID on the connection.
    this.invalidate(ended);
    if (reason === 'target-crashed') void this.connection.cleanupAttachment(this.id!);
  }
  detach(options: WaitOptions = {}): Promise<void> {
    if (this.detaching) return this.detaching;
    if (this.closed) return Promise.resolve();
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    timeoutValue(options.timeout ?? this.connection.timeout);
    this.end('detach-requested');
    return (this.detaching = this.connection.detachAttachment(this.id!, options));
  }
}
