import { AsyncLocalStorage } from 'node:async_hooks';
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';
import type { Transport } from '../transport/transport.ts';
import {
  DisconnectedError,
  ProtocolError,
  SessionEndedError,
  TimeoutError,
  type EndReason,
  type SessionEndReason,
} from '../errors.ts';
import {
  abortReason,
  bounded,
  EventHub,
  timeoutValue,
  type Listener,
  type WaitOptions,
} from '../utils.ts';
import { isAttachmentGone } from './errors.ts';
export { SessionEndedError, type EndReason, type SessionEndReason };
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
export interface DrainOptions extends WaitOptions {
  /**
   * How to handle unanswerable commands belonging to sessions that detached before replying:
   * - `'ignore'` (default): wait only for active, still-answerable requests and cleanup.
   * - `'throw'`: once answerable requests settle, reject immediately with `SessionEndedError`
   *   if any detached unanswerable command exists.
   */
  detached?: 'ignore' | 'throw';
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
  /**
   * Synchronous pre-send guard invoked before a CDP command is queued, serialized or written to
   * the transport. Throwing rejects that command before it touches the wire, without adding
   * pending/unanswered wire debt or invoking send observers. Zero overhead when omitted.
   */
  beforeSend?: (method: string, params: unknown, sessionId?: string) => void;
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
  /** Whether a RequestRecorder (e.g. InputAction ledger) is tracking this request ID. */
  hasLedger?: boolean;
  /** Told when the reply arrives, and whether its caller had stopped waiting by then. */
  replied?: (late: boolean, succeeded: boolean) => void;
  /** Invoked synchronously if a successful CDP reply arrives after the caller stopped waiting. */
  onLateReply?: (result: unknown) => void;
  /** For root `Target.setDiscoverTargets`, tracks the requested discovery state on the wire. */
  discoverTargets?: boolean;
}
interface DetachedWire {
  method: string;
  sessionId: string;
  at: number;
  transportAt?: number;
  ended: SessionEndedError;
  replied?: (late: boolean, succeeded: boolean) => void;
}
const ATTACH_CLEANUP_TIMEOUT = 5000;
const MAX_DETACHED_WIRES = 512;
/**
 * @internal Receives the ID and method of each request a connection creates for its owner, and
 * its session and parameters. Its listeners observe transport dispatch and the reply, including
 * replies that arrive after the caller stopped waiting.
 */
export type RequestRecorder = (
  connection: Connection,
  id: number,
  method: string,
  session?: Session,
  params?: unknown,
) => void | { sent?: () => void; replied?: (late: boolean, succeeded: boolean) => void };
/** @internal Options key: records the ID of the request sent with these options. */
export const REQUEST_LEDGER = Symbol('nodriver.requestLedger');
/** @internal Options key: receives a successful CDP reply that arrives after the caller stopped waiting. */
export const ON_LATE_REPLY = Symbol('nodriver.onLateReply');
/** @internal */
export type LedgerOptions = WaitOptions & {
  [REQUEST_LEDGER]?: RequestRecorder;
  [ON_LATE_REPLY]?: (result: unknown) => void;
};
/** @internal Records requests sent within an async context, such as an input action. */
export const requestLedger = new AsyncLocalStorage<RequestRecorder>();
export class Connection {
  private nextId = 0;
  private pending = new Map<number, Pending>();
  /** Active (non-detached) send attempts still awaiting a correlated CDP response. */
  private unanswered = new Map<number, Unanswered>();
  /**
   * Bounded FIFO retention of requests whose session detached before replying, kept solely to
   * correlate late browser-level errors for `observe.onResponse` and report `detached: 'throw'`.
   */
  private detachedWires = new Map<number, DetachedWire>();
  /** Detached requests tracked by an active RequestRecorder ledger until consumed by unanswerable(). */
  private detachedLedger = new Map<number, string>();
  /** Requests that were awaiting settlement or a reply when the connection closed. */
  private lost = new Set<number>();
  private sessions = new Map<string, Session>();
  private sessionParents = new Map<string, string>();
  /** Target ID of each attachment, when known, for SessionEndedError. */
  private sessionTargets = new Map<string, string>();
  /** Target type of each attachment, for errors. */
  private targetTypes = new Map<string, string>();
  /**
   * Per-session crash generation tracking pairing Chrome's two independent crash channels
   * (`Inspector.targetCrashed` on the page session and `Target.targetCrashed` on browser root).
   * Each distinct crash advances `generation` once and records its pre-crash request watermark so a
   * lagging second notification (even after recovery commits) never retires new requests or cancels
   * a recovery navigation.
   */
  private crashStates = new Map<
    string,
    {
      inspectorCount: number;
      targetCount: number;
      generation: number;
      watermarks: Map<number, number>;
    }
  >();
  /** Last confirmed root `Target.setDiscoverTargets` state (`undefined` if never confirmed). */
  private targetDiscovery?: boolean;
  /** Request ID of the highest-seq confirmed root `Target.setDiscoverTargets` reply. */
  private targetDiscoveryConfirmedSeq = 0;
  /**
   * In-flight root `Target.setDiscoverTargets({ discover: true })` request IDs mapped to an
   * optional deferred disable boundary (`firstConfirmedEnableAfterThis`, or `undefined` when no
   * confirmed disable is waiting on this candidate). Strictly 1 entry per unanswered enable.
   */
  private inFlightDiscoverEnables = new Map<number, number | undefined>();
  /**
   * In-flight root `Target.setDiscoverTargets({ discover: false })` commands mapped to the
   * earliest confirmed `discover: true` request ID after each (`Infinity` if none yet).
   * Strictly 1 entry per unanswered disable.
   */
  private inFlightDiscoverDisables = new Map<number, number>();
  private abandoned = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; recorder?: RequestRecorder }
  >();
  private sendQueue: Array<() => void> = [];
  private sending = false;
  private cleanupCount = 0;
  private settlingCount = 0;
  private sessionSettling = new Map<string, number>();
  private attachingIds = new Map<string, SessionEndReason | undefined>();
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
   * Active (non-detached) send attempts without a correlated response. Cancellation and timeout
   * keep this debt until a response arrives or the session detaches / connection closes; requests
   * belonging to detached sessions move to `detachedUnansweredCount` so `drain()` does not hang.
   */
  get unansweredCount(): number {
    return this.unanswered.size;
  }
  /**
   * Recently detached send attempts that had not received a response before their session ended
   * (bounded FIFO retention for late browser-level error correlation).
   */
  get detachedUnansweredCount(): number {
    return this.detachedWires.size;
  }
  /**
   * Wait for active caller requests, answerable wire replies and library attachment cleanup.
   * Requests belonging to already-detached sessions do not hang `drain()` by default
   * (`detached: 'ignore'`); pass `{ detached: 'throw' }` to reject with `SessionEndedError` once
   * answerable debt reaches zero. Rejects on disconnect/timeout/abort; never retries commands or
   * closes the connection itself. Stop producers first: this is a quiescence check, not a lock.
   */
  drain(options: DrainOptions = {}): Promise<void> {
    const mode = this.drainDetachedMode(options.detached);
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
      mode === 'throw' ? () => this.detachedWires.values().next().value?.ended : undefined,
    );
  }
  /**
   * Wait until one session's active requests, wire replies and `onSettle` observers have settled,
   * without waiting on unrelated sessions sharing the same `Connection`.
   */
  drainSession(sessionId: string | undefined, options: DrainOptions = {}): Promise<void> {
    const mode = this.drainDetachedMode(options.detached);
    const settleKey = sessionId ?? '';
    return this.waitIdle(
      () => {
        if (this.sending || this.sendQueue.length) return false;
        if ((this.sessionSettling.get(settleKey) ?? 0) > 0) return false;
        for (const p of this.pending.values()) if (p.sessionId === sessionId) return false;
        for (const w of this.unanswered.values()) if (w.sessionId === sessionId) return false;
        return true;
      },
      options,
      mode === 'throw'
        ? () => {
            for (const w of this.detachedWires.values())
              if (w.sessionId === sessionId) return w.ended;
            return undefined;
          }
        : undefined,
    );
  }
  private drainDetachedMode(mode: DrainOptions['detached']): 'ignore' | 'throw' {
    if (mode === undefined || mode === 'ignore' || mode === 'throw') return mode ?? 'ignore';
    throw new TypeError('detached must be "ignore" or "throw"');
  }
  private recordDetachedWire(id: number, wire: DetachedWire): void {
    this.detachedWires.set(id, wire);
    while (this.detachedWires.size > MAX_DETACHED_WIRES) {
      const oldest = this.detachedWires.keys().next().value;
      if (oldest === undefined) break;
      this.detachedWires.delete(oldest);
    }
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
      if (this.pending.has(id) || this.unanswered.has(id)) return true;
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
      if (
        this.pending.has(id) ||
        this.unanswered.has(id) ||
        this.detachedLedger.has(id) ||
        this.lost.has(id)
      )
        found = true;
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
      const sessionId = this.detachedLedger.get(id);
      if (sessionId === undefined) continue;
      sessions.add(sessionId);
      this.detachedLedger.delete(id);
      ledger.delete(id);
    }
    return sessions;
  }
  private waitIdle(
    idle: () => boolean,
    options: WaitOptions,
    detachedError?: () => SessionEndedError | undefined,
  ): Promise<void> {
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
        else if (idle()) finish(detachedError?.());
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
  /** @internal The session with this ID if one exists; unlike session(), never creates one. */
  knownSession(id: string): Session | undefined {
    return this.sessions.get(id);
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
          if (ended) throw new SessionEndedError(ended, targetId, { sessionId: id });
          session = new TargetSession(this, id, targetId);
          // A root listener may have made a plain Session for this attachment; events now go here.
          this.sessions.get(id)?.invalidate(
            new SessionEndedError('detached', targetId, {
              sessionId: id,
              detail: `Session ${id} was replaced by attachSession()`,
            }),
          );
          this.sessionTargets.set(id, targetId);
          this.sessions.set(id, session);
        },
      },
    ).then(() => session);
  }
  /** @internal Attaches a plain high-level Session with abandoned-attach cleanup on cancellation. */
  attachPlainSession(targetId: string, options: WaitOptions = {}): Promise<Session> {
    let session!: Session;
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
          if (ended) throw new SessionEndedError(ended, targetId, { sessionId: id });
          this.sessionTargets.set(id, targetId);
          session = this.session(id);
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
      if (isAttachmentGone(error)) return;
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
      if (isAttachmentGone(error)) return;
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
    const session = sessionId === undefined ? undefined : this.sessions.get(sessionId);
    const beforeSend = this.options.beforeSend;
    if (beforeSend) {
      try {
        beforeSend(method, params[0], sessionId);
      } catch (error) {
        return Promise.reject(error);
      }
      if (this.failure) return Promise.reject(this.failure);
      if (session?.closed)
        return Promise.reject(
          session.closeReason ??
            new SessionEndedError(
              'detached',
              session instanceof TargetSession
                ? session.targetId
                : (this.sessionTargets.get(sessionId!) ?? ''),
              { sessionId },
            ),
        );
      if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    }
    const id = ++this.nextId;
    const recorder = (options as LedgerOptions)[REQUEST_LEDGER] ?? requestLedger.getStore();
    const onLateReply = (options as LedgerOptions)[ON_LATE_REPLY];
    const recorded = recorder?.(this, id, method, session, params[0]) ?? undefined;
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
        const serializingAt = metrics ? performance.now() : 0;
        let message: string;
        try {
          message = JSON.stringify({ id, method, params: params[0], sessionId });
        } catch (e) {
          cancel(e as Error);
          return;
        }
        try {
          started = performance.now();
          sentOnWire = true;
          const discoverTargets =
            sessionId === undefined && method === 'Target.setDiscoverTargets'
              ? Boolean((params[0] as { discover?: boolean } | undefined)?.discover)
              : undefined;
          if (discoverTargets === true) {
            // Only confirmed disables (<= targetDiscoveryConfirmedSeq) cut off earlier enable
            // candidates; a failed or still-in-flight disable must not clear an active enable's
            // crash pairings.
            const hasEarlierCandidate = [...this.inFlightDiscoverEnables.keys()].some(
              (seq) => seq > this.targetDiscoveryConfirmedSeq,
            );
            if (this.targetDiscovery !== true && !hasEarlierCandidate) {
              this.reconcileUnpairedRootCrashes(id);
              this.inFlightDiscoverEnables.set(id, Infinity);
            } else {
              this.inFlightDiscoverEnables.set(id, undefined);
            }
          } else if (discoverTargets === false) {
            this.inFlightDiscoverDisables.set(id, Infinity);
          }
          const wire: Unanswered = {
            method,
            sessionId,
            at: started,
            ...(recorder ? { hasLedger: true } : {}),
            replied: recorded?.replied,
            ...(onLateReply ? { onLateReply } : {}),
            ...(discoverTargets !== undefined ? { discoverTargets } : {}),
          };
          this.unanswered.set(id, wire);
          try {
            recorded?.sent?.();
          } catch {}
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
          if (sent) void sent.catch((e) => this.failTransport(e));
        } catch (e) {
          this.failTransport(e);
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
      const settleKey = sessionId ?? '';
      this.sessionSettling.set(settleKey, (this.sessionSettling.get(settleKey) ?? 0) + 1);
      const settled = (error?: Error) => {
        record(error);
        this.settlingCount--;
        const remaining = (this.sessionSettling.get(settleKey) ?? 1) - 1;
        if (remaining <= 0) this.sessionSettling.delete(settleKey);
        else this.sessionSettling.set(settleKey, remaining);
        this.notifyDrain();
      };
      void pending.then(() => settled(), settled);
    }
    return pending;
  }
  private failTransport(e: unknown): void {
    const failure =
      e instanceof DisconnectedError
        ? e
        : e instanceof Error
          ? new DisconnectedError(e.message, { cause: e })
          : new DisconnectedError(String(e), { cause: e });
    this.finish(failure);
    try {
      void Promise.resolve(this.transport.close()).catch(() => {});
    } catch {}
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
        const activeWire = this.unanswered.get(m.id);
        const detachedWire = activeWire ? undefined : this.detachedWires.get(m.id);
        const wire = activeWire ?? detachedWire;
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
        if (activeWire) this.unanswered.delete(m.id);
        else this.detachedWires.delete(m.id);
        this.detachedLedger.delete(m.id);
        if (activeWire?.discoverTargets !== undefined) {
          if (activeWire.discoverTargets) {
            const deferBoundary = this.inFlightDiscoverEnables.get(m.id);
            this.inFlightDiscoverEnables.delete(m.id);
            if (!m.error) {
              if (m.id > this.targetDiscoveryConfirmedSeq) {
                this.targetDiscoveryConfirmedSeq = m.id;
                this.targetDiscovery = true;
              }
              for (const [disableSeq, firstConfirmed] of this.inFlightDiscoverDisables) {
                if (m.id > disableSeq && m.id < firstConfirmed) {
                  this.inFlightDiscoverDisables.set(disableSeq, m.id);
                }
              }
              for (const [enableSeq, bound] of this.inFlightDiscoverEnables) {
                if (bound !== undefined && m.id > enableSeq && m.id < bound) {
                  this.inFlightDiscoverEnables.set(enableSeq, m.id);
                }
              }
              if (deferBoundary !== undefined) {
                this.reconcileUnpairedRootCrashes(m.id);
              }
            } else if (deferBoundary !== undefined) {
              const nextPending = this.minPendingEnableAfter(m.id);
              this.reconcileUnpairedRootCrashes(Math.min(deferBoundary, nextPending));
              if (nextPending < deferBoundary) {
                this.attachDeferredDisable(nextPending, deferBoundary);
              }
            }
          } else {
            const firstConfirmed = this.inFlightDiscoverDisables.get(m.id) ?? Infinity;
            this.inFlightDiscoverDisables.delete(m.id);
            if (!m.error) {
              if (m.id > this.targetDiscoveryConfirmedSeq) {
                this.targetDiscoveryConfirmedSeq = m.id;
                this.targetDiscovery = false;
              }
              const minPending = this.minPendingEnableAfter(m.id);
              this.reconcileUnpairedRootCrashes(Math.min(firstConfirmed, minPending));
              if (minPending < firstConfirmed) {
                this.attachDeferredDisable(minPending, firstConfirmed);
              }
            }
          }
        }
        if (activeWire && !p && !m.error && activeWire.onLateReply) {
          // Run synchronously before wire.replied so any cleanup commands started here are
          // tracked by Connection.drain() and InputAction cleanup before this reply settles.
          try {
            activeWire.onLateReply(m.result ?? {});
          } catch {}
        }
        try {
          wire.replied?.(!p, !m.error);
        } catch {}
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
        if (detached) {
          const session = p.sessionId ? this.sessions.get(p.sessionId) : undefined;
          const targetId =
            session instanceof TargetSession
              ? session.targetId
              : (this.sessionTargets.get(p.sessionId!) ?? '');
          p.reject(
            new SessionEndedError('detached', targetId, {
              sessionId: p.sessionId,
              detail: m.error!.message,
            }),
          );
        } else if (m.error)
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
          const event = m.params as {
            sessionId: string;
            targetInfo?: { targetId?: string; type?: string };
          };
          if (event.targetInfo?.type) this.targetTypes.set(event.sessionId, event.targetInfo.type);
          if (event.targetInfo?.targetId)
            this.sessionTargets.set(event.sessionId, event.targetInfo.targetId);
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
          this.detach(id);
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
          if (reason === 'target-destroyed') {
            for (const [sid, tid] of [...this.sessionTargets]) {
              if (tid !== targetId) continue;
              this.detach(
                sid,
                new SessionEndedError('target-destroyed', targetId, { sessionId: sid }),
              );
            }
          } else {
            // Plain Sessions (high-level Tabs) stay open so they can recover via navigation,
            // but requests sent to the crashed renderer will never answer and must not hang drain().
            for (const [sid, tid] of [...this.sessionTargets]) {
              if (tid !== targetId || this.sessions.get(sid) instanceof TargetSession) continue;
              this.onPlainSessionCrashed(sid, targetId, 'target');
            }
          }
        }
        if (m.method === 'Inspector.targetCrashed' && m.sessionId) {
          const session = this.sessions.get(m.sessionId);
          if (session instanceof TargetSession) session.end('target-crashed');
          else
            this.onPlainSessionCrashed(
              m.sessionId,
              this.sessionTargets.get(m.sessionId) ?? '',
              'inspector',
            );
        }
        if (m.method === 'Page.frameNavigated' && m.sessionId) {
          const frame = (m.params as { frame?: { parentId?: string } } | undefined)?.frame;
          if (frame && !frame.parentId) {
            // `Inspector.targetCrashed` and `Page.frameNavigated` are FIFO-ordered on the same
            // session: once a new main document commits, any earlier lone `Target.targetCrashed`
            // cannot have a lagging `Inspector.targetCrashed` arrive later, whereas an unpaired
            // `Inspector.targetCrashed` may still receive a late root `Target.targetCrashed` and
            // must keep its watermark.
            const state = this.crashStates.get(m.sessionId);
            if (state && state.inspectorCount < state.targetCount) {
              for (let gen = state.inspectorCount + 1; gen <= state.targetCount; gen++) {
                state.watermarks.delete(gen);
              }
              state.inspectorCount = state.targetCount;
            }
          }
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
  private minPendingEnableAfter(seq: number): number {
    let min = Infinity;
    for (const enableSeq of this.inFlightDiscoverEnables.keys()) {
      if (enableSeq > seq && enableSeq < min) min = enableSeq;
    }
    return min;
  }
  private attachDeferredDisable(enableSeq: number, firstConfirmed: number): void {
    const prev = this.inFlightDiscoverEnables.get(enableSeq);
    if (prev === undefined || firstConfirmed < prev) {
      this.inFlightDiscoverEnables.set(enableSeq, firstConfirmed);
    }
  }
  /**
   * Closes unpaired `Inspector.targetCrashed` records whose watermark is strictly before
   * `beforeSeq`, since root target discovery was disabled before that boundary and Chrome will
   * never emit a paired root `Target.targetCrashed` for them.
   */
  private reconcileUnpairedRootCrashes(beforeSeq = Infinity): void {
    for (const state of this.crashStates.values()) {
      while (state.targetCount < state.inspectorCount) {
        const nextGen = state.targetCount + 1;
        const wm = state.watermarks.get(nextGen);
        if (wm !== undefined && wm >= beforeSeq) break;
        state.watermarks.delete(nextGen);
        state.targetCount = nextGen;
      }
    }
  }
  /**
   * Pairs the session-level (`Inspector.targetCrashed`) and browser-level (`Target.targetCrashed`)
   * channels per crash generation:
   * - The first notification of generation `k` advances `state.generation`, captures `watermark`,
   *   retires requests `<= watermark`, and notifies `session.crashed` once.
   * - The lagging second notification of generation `k` (even arriving after a recovery navigation
   *   has committed) reuses generation `k`'s watermark and does not fire `session.crashed` again.
   */
  private onPlainSessionCrashed(
    id: string,
    targetId: string,
    source: 'inspector' | 'target',
  ): void {
    let state = this.crashStates.get(id);
    if (!state) {
      state = { inspectorCount: 0, targetCount: 0, generation: 0, watermarks: new Map() };
      this.crashStates.set(id, state);
    }
    const seq = source === 'inspector' ? ++state.inspectorCount : ++state.targetCount;
    const isNewCrash = seq > state.generation;
    let watermark: number;
    if (isNewCrash) {
      state.generation = seq;
      watermark = this.nextId;
      const hasNewerEnableInFlight = [...this.inFlightDiscoverEnables.keys()].some(
        (enableSeq) => enableSeq > this.targetDiscoveryConfirmedSeq,
      );
      if (source === 'inspector' && this.targetDiscovery === false && !hasNewerEnableInFlight) {
        // Root discovery is confirmed off with no newer enable in flight, so no paired
        // Target.targetCrashed will ever arrive.
        state.targetCount = seq;
      } else {
        state.watermarks.set(seq, watermark);
        while (state.watermarks.size > 16) {
          const oldest = state.watermarks.keys().next().value;
          if (oldest === undefined) break;
          state.watermarks.delete(oldest);
        }
      }
    } else {
      watermark = state.watermarks.get(seq) ?? 0;
      state.watermarks.delete(seq);
    }
    const ended = new SessionEndedError('target-crashed', targetId, { sessionId: id });
    this.retireCrashedSession(id, targetId, watermark, ended);
    if (isNewCrash) this.sessions.get(id)?.noteCrash(ended);
  }
  /**
   * Retires pre-crash pending and unanswered requests (up to `watermark`) for a plain Session
   * without invalidating the session itself, so high-level Tabs can recover by navigating to a new
   * document while Connection.drain() no longer waits forever for the dead renderer.
   */
  private retireCrashedSession(
    id: string,
    targetId: string,
    watermark: number,
    ended: SessionEndedError,
  ): void {
    for (const [child, parent] of this.sessionParents) {
      if (parent === id && !(this.sessions.get(child) instanceof TargetSession)) {
        const childTarget = this.sessionTargets.get(child) ?? targetId;
        this.retireCrashedSession(
          child,
          childTarget,
          watermark,
          new SessionEndedError('target-crashed', childTarget, { sessionId: child }),
        );
      }
    }
    for (const [key, p] of this.pending) {
      if (p.sessionId !== id || key > watermark) continue;
      this.pending.delete(key);
      p.cleanup();
      p.reject(ended);
    }
    for (const [reqId, wire] of this.unanswered) {
      if (wire.sessionId !== id || reqId > watermark) continue;
      this.unanswered.delete(reqId);
      if (wire.hasLedger) this.detachedLedger.set(reqId, id);
      this.recordDetachedWire(reqId, {
        method: wire.method,
        sessionId: id,
        at: wire.at,
        transportAt: wire.transportAt,
        ended,
        replied: wire.replied,
      });
    }
    this.notifyDrain();
  }
  detach(id: string, reason?: Error): void {
    const session = this.sessions.get(id);
    const targetId =
      session instanceof TargetSession ? session.targetId : (this.sessionTargets.get(id) ?? '');
    const ended =
      reason instanceof SessionEndedError
        ? reason
        : new SessionEndedError('detached', targetId, {
            sessionId: id,
            ...(reason ? { cause: reason } : {}),
          });
    // Parent detach can suppress descendant detach events (notably BFCache
    // OOPIFs when their tab/context closes). Retire the whole ownership tree.
    this.sessionParents.delete(id);
    this.targetTypes.delete(id);
    this.sessionTargets.delete(id);
    this.crashStates.delete(id);
    for (const [child, parent] of this.sessionParents) if (parent === id) this.detach(child, ended);
    for (const [key, p] of this.pending)
      if (p.sessionId === id) {
        this.pending.delete(key);
        p.cleanup();
        p.reject(ended);
      }
    for (const [reqId, wire] of this.unanswered) {
      if (wire.sessionId !== id) continue;
      this.unanswered.delete(reqId);
      if (wire.hasLedger) this.detachedLedger.set(reqId, id);
      this.recordDetachedWire(reqId, {
        method: wire.method,
        sessionId: id,
        at: wire.at,
        transportAt: wire.transportAt,
        ended,
        replied: wire.replied,
      });
    }
    session?.invalidate(ended);
    this.sessions.delete(id);
    this.routes.delete(id);
    this.notifyDrain();
  }
  private finish(reason: Error): void {
    if (this.failure) return;
    const failure =
      reason instanceof DisconnectedError
        ? reason
        : new DisconnectedError(reason.message || 'CDP connection closed', { cause: reason });
    this.failure = failure;
    for (const p of this.pending.values()) {
      p.cleanup();
      p.reject(failure);
    }
    for (const id of this.pending.keys()) this.lost.add(id);
    for (const id of this.unanswered.keys()) this.lost.add(id);
    for (const id of this.detachedLedger.keys()) this.lost.add(id);
    this.pending.clear();
    this.unanswered.clear();
    this.detachedWires.clear();
    this.detachedLedger.clear();
    for (const { timer } of this.abandoned.values()) clearTimeout(timer);
    this.abandoned.clear();
    this.attachingIds.clear();
    this.root.invalidate(failure);
    for (const s of this.sessions.values()) s.invalidate(failure);
    this.sessions.clear();
    this.sessionParents.clear();
    this.sessionTargets.clear();
    this.targetTypes.clear();
    this.crashStates.clear();
    this.targetDiscovery = undefined;
    this.targetDiscoveryConfirmedSeq = 0;
    this.inFlightDiscoverEnables.clear();
    this.inFlightDiscoverDisables.clear();
    this.disconnected.emit(failure);
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
  /** @internal Emits once per distinct renderer crash generation (deduplicated across Inspector/Target). */
  readonly crashed: EventHub<SessionEndedError>;
  readonly connection: Connection;
  readonly id?: string;
  constructor(connection: Connection, id?: string) {
    this.connection = connection;
    this.id = id;
    this.disconnected = new EventHub<Error>(connection.options.onError);
    this.crashed = new EventHub<SessionEndedError>(connection.options.onError);
  }
  /** @internal Notifies crash subscribers once per distinct crash generation. */
  noteCrash(reason: SessionEndedError): void {
    if (!this.failure) this.crashed.emit(reason);
  }
  get closed(): boolean {
    return !!this.failure || this.connection.closed;
  }
  /** The error that ended this session or its connection, once closed. */
  get closeReason(): Error | undefined {
    return this.failure ?? this.connection.closeReason;
  }
  /** @internal The error to throw when an operation observes this session is closed. */
  closedError(): Error {
    return this.closeReason ?? new DisconnectedError('Session closed');
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
  /** Wait for this session's active requests, wire replies and `onSettle` observers to settle. */
  drain(options: DrainOptions = {}): Promise<void> {
    return this.connection.drainSession(this.id, options);
  }
  on<E extends Event>(method: E, listener: Listener<EventParams<E>>): () => void {
    if (this.closed) throw this.closedError();
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
    if (this.closed) throw this.closedError();
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
    if (this.closed) return Promise.reject(this.closedError());
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const timeout = timeoutValue(options.timeout ?? this.connection.timeout);
    return new Promise((resolve, reject) => {
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
    this.crashed.clear();
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
    if (error instanceof SessionEndedError) {
      const ended =
        error.targetId === this.targetId
          ? error
          : new SessionEndedError(error.reason, this.targetId, {
              sessionId: this.id,
              cause: error,
            });
      this.reason = ended.reason;
      super.invalidate(ended);
    } else {
      this.reason = 'disconnected';
      super.invalidate(error);
    }
    this.resolveEnded(this.reason);
  }
  /** @internal */
  end(reason: SessionEndReason): void {
    if (this.closed) return;
    const ended = new SessionEndedError(reason, this.targetId, { sessionId: this.id });
    this.connection.detach(this.id!, ended);
    // Also when another session object has taken over this ID on the connection.
    this.invalidate(ended);
    if (reason === 'target-crashed') void this.connection.cleanupAttachment(this.id!);
  }
  detach(options: WaitOptions = {}): Promise<void> {
    if (options.timeout !== undefined) timeoutValue(options.timeout);
    if (this.detaching) return bounded(this.detaching, options, 'TargetSession.detach');
    if (this.closed) return Promise.resolve();
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    timeoutValue(options.timeout ?? this.connection.timeout);
    this.end('detach-requested');
    return (this.detaching = this.connection.detachAttachment(this.id!, options));
  }
}
