import { randomUUID } from 'node:crypto';
import type { Protocol } from 'devtools-protocol';
import {
  ON_LATE_REPLY,
  TargetSession,
  type Connection,
  type LedgerOptions,
  type Session,
} from '../protocol/connection.ts';
import {
  DisconnectedError,
  EvaluationError,
  ProtocolError,
  SessionEndedError,
  StaleElementError,
  TimeoutError,
} from '../errors.ts';
import {
  CONTEXT_GONE,
  isContextGone,
  isFrameGone,
  isNodeGone,
  isObjectGone,
  isWorldMismatch,
} from '../protocol/errors.ts';
import {
  abortReason,
  bounded,
  budget,
  MAX_TIMEOUT,
  positiveInt,
  timeoutValue,
  withSignal,
  type WaitOptions,
} from '../utils.ts';
import { parseRemoteObjectId } from './execution-context.ts';
import {
  decodeRemoteValue,
  encodeCallArgument,
  formatExceptionDetails,
  releaseObjectGroup,
  releaseRemoteObjects as releaseObjects,
} from './runtime.ts';

export type IsolatedWorldScope = 'session' | 'target';
export type IsolatedWorldVerification = 'strict' | 'guard' | 'none';
export type IsolatedWorldEvent = 'created' | 'create-failed' | 'recovered';

export interface IsolatedWorldEventInfo {
  readonly targetId?: string;
  readonly frameId: string;
  readonly worldName: string;
  readonly contextId?: number;
  readonly error?: unknown;
}

export type IsolatedWorldObserver = (
  event: IsolatedWorldEvent,
  info: IsolatedWorldEventInfo,
) => void;

export interface IsolatedWorldOptions {
  /**
   * Frame to create the isolated world in. Defaults to `targetId` (from `TargetSession.targetId`
   * or `options.targetId`). Required for a plain `Session` without `targetId`.
   */
  frameId?: string;
  /**
   * Name passed to `Page.createIsolatedWorld`. Must be a non-empty string when specified.
   * Defaults to a random UUID (per `IsolatedWorld` instance, per `Session` for session-scoped
   * `evaluateIsolated()`, or per `Connection` for target-scoped `evaluateIsolated()`).
   */
  worldName?: string;
  /** Passed to `Page.createIsolatedWorld({ grantUniveralAccess })`. Defaults to false. */
  grantUniversalAccess?: boolean;
  /**
   * Cache and lifecycle granularity:
   * - `'session'` (default): bound to `session`.
   * - `'target'`: shared across ephemeral `TargetSession`s on the same `Connection` by
   *   `(targetId, frameId, worldName, grantUniversalAccess, verification)`. Requires a
   *   `TargetSession` or an explicit `targetId`. `dispose()` on a wrapper instance stops only that
   *   instance's pending waits without evicting the shared target cache; use `invalidate()` or
   *   `invalidateIsolatedWorlds(connection, filter)` to evict cached entries.
   */
  scope?: IsolatedWorldScope;
  /** Explicit owning target ID when using `scope: 'target'` with a plain `Session`. */
  targetId?: string;
  /**
   * World binding verification level:
   * - `'strict'` (default for `scope: 'session'`): binds a `globalThis` `RemoteObjectId` handle and
   *   verifies against the frame's main world (`DOM.describeNode` + `DOM.resolveNode`) and named
   *   world. Supported only with `scope: 'session'` because Chromium object handles end with their
   *   `TargetSession`.
   * - `'guard'` (default for `scope: 'target'`): zero `DOM.*` / main-world touch; on cold bind,
   *   binds a temporary `globalThis` handle, re-confirms `(frameId, worldName)` via
   *   `Page.createIsolatedWorld`, stamps a single non-enumerable random token onto that verified
   *   handle via `Runtime.callFunctionOn`, and releases the temporary object group before returning
   *   (for `evaluate()`, `context()`, and `run()` alike). Warm calls across new `TargetSession`s
   *   verify that token read-only in 1 RTT, preventing cross-process numeric `executionContextId`
   *   reuse from executing user code or writing properties in the wrong world.
   * - `'none'`: zero `DOM.*` / main-world touch, zero `globalThis` properties, zero remote handles,
   *   and unwrapped string expressions on `Runtime.evaluate` (2-RTT cold start, 1-RTT warm
   *   `evaluate()`, 0-RTT warm `context()` / `run()`).
   */
  verification?: IsolatedWorldVerification;
  /**
   * Lightweight lifecycle observer invoked on world creation attempts (`'created'`,
   * `'create-failed'`, `'recovered'`). Observer exceptions are isolated.
   */
  onEvent?: IsolatedWorldObserver;
}

export interface IsolatedRunOptions extends WaitOptions {
  /**
   * Rebuild the isolated world and retry once if Chrome reports `isContextGone(error)` or a
   * context-binding mismatch. Defaults to true. Set to false when the callback has side effects
   * that must never replay.
   */
  retryOnContextGone?: boolean;
  /** Per-call lifecycle observer invoked in addition to `IsolatedWorldOptions.onEvent`. */
  onEvent?: IsolatedWorldObserver;
}

export interface IsolatedEvaluateOptions extends IsolatedRunOptions {
  /** CDP execution limit in milliseconds (`Runtime.evaluate.timeout`). Does not cancel timers/tasks. */
  executionTimeout?: number;
  /**
   * Passed to `Runtime.evaluate` / `Runtime.callFunctionOn`: suppresses `Runtime.exceptionThrown`
   * notifications and `setPauseOnException` breaks while still returning `exceptionDetails`
   * (`EvaluationError`). Omitted when `undefined`.
   */
  silent?: boolean;
  /**
   * Passed to `Runtime.evaluate`: disables breakpoints during execution. Setting this routes
   * evaluation (including function `fn` with serializable `arg`) through `Runtime.evaluate`.
   * Omitted when `undefined`.
   */
  disableBreaks?: boolean;
  /**
   * Passed to `Runtime.evaluate`: throws if V8 cannot rule out side effects (note that V8 also
   * rejects layout-inducing DOM getters under `throwOnSideEffect: true`). Never applied to internal
   * guard-token initialization. Omitted when `undefined`.
   */
  throwOnSideEffect?: boolean;
  /**
   * Passed to `Runtime.evaluate` / `Runtime.callFunctionOn`: treats execution as user-initiated
   * (triggers synthetic user activation; leave `undefined` when activation state is sensitive).
   */
  userGesture?: boolean;
}

export interface EvaluateIsolatedOptions extends IsolatedWorldOptions, IsolatedEvaluateOptions {}

export interface InvalidateIsolatedWorldsFilter {
  targetId?: string;
  frameId?: string;
  worldName?: string;
}

export interface IsolatedCallOnNodesOptions extends IsolatedRunOptions {
  /** Nodes resolved and evaluated per batch. Positive integer; defaults to 128. */
  chunkSize?: number;
  /** Forwarded to `Runtime.callFunctionOn`. Omitted when `undefined`. */
  silent?: boolean;
  /** Forwarded to `Runtime.callFunctionOn`. Omitted when `undefined`. */
  throwOnSideEffect?: boolean;
  /** Forwarded to `Runtime.callFunctionOn`. Omitted when `undefined`. */
  userGesture?: boolean;
  /**
   * Mark disconnected nodes (`!el.isConnected`) as `{ ok: false, stale: true }` instead of
   * invoking `fn`. Defaults to `true`.
   */
  requireConnected?: boolean;
  /**
   * Mark nodes whose `DOM.resolveNode` fails with `No node found` as `{ ok: false, stale: true }`
   * instead of rejecting. Defaults to `true`.
   */
  skipMissingNodes?: boolean;
}

/** Rejects async / Promise-returning callbacks in `IsolatedWorld.callOnNodes()`. */
export type SyncNodeCallResult<T> = T extends PromiseLike<unknown> ? never : T;

export type NodeCallResult<T> =
  | {
      readonly ok: true;
      readonly backendNodeId: Protocol.DOM.BackendNodeId;
      readonly value: T;
    }
  | {
      readonly ok: false;
      readonly backendNodeId: Protocol.DOM.BackendNodeId;
      readonly stale: true;
    };

export type IsolatedWorldPoolOptions = Omit<IsolatedWorldOptions, 'frameId'>;

export type FrameEvaluationOutcome<T> =
  | { readonly status: 'ok'; readonly frameId: string; readonly value: T }
  | { readonly status: 'detached'; readonly frameId: string; readonly error: StaleElementError }
  | { readonly status: 'error'; readonly frameId: string; readonly error: unknown };

export interface EvaluateAcrossFramesOptions
  extends IsolatedWorldPoolOptions, IsolatedEvaluateOptions {
  /** Maximum frames evaluated concurrently. Positive integer; defaults to all frames in parallel. */
  concurrency?: number;
}

/**
 * Managed CDP `Runtime` object-group lease implementing `AsyncDisposable`.
 * Releases all handles in the group via `Runtime.releaseObjectGroup` and tracks confirmation
 * separately from in-flight attempts so a cancelled or timed-out `release()` can be retried.
 */
export class ObjectGroupScope implements AsyncDisposable {
  readonly session: Session;
  readonly name: string;
  private confirmed = false;
  private releaseStarted = false;
  private inFlight?: Promise<void>;
  private confirmWaiters?: Set<() => void>;

  constructor(session: Session, name?: string) {
    if (name !== undefined && !name)
      throw new TypeError('objectGroup name must be a non-empty string');
    this.session = session;
    this.name = name ?? `nodriver-group-${randomUUID()}`;
  }

  /** True once `Runtime.releaseObjectGroup` has been confirmed or the session/connection has closed. */
  get released(): boolean {
    return this.confirmed || this.session.closed;
  }

  /** @internal True once a `Runtime.releaseObjectGroup` attempt has been dispatched or confirmed. */
  get releasing(): boolean {
    return this.releaseStarted || this.released;
  }

  private markConfirmed(): void {
    if (this.confirmed) return;
    this.confirmed = true;
    const waiters = this.confirmWaiters;
    this.confirmWaiters = undefined;
    if (waiters) for (const wake of waiters) wake();
  }

  /**
   * Releases every remote object in this group (1 s default caller timeout, applied even when only
   * `signal` is provided). Idempotent once confirmed or once the session closes. Pre-aborted calls
   * send no CDP command; concurrent and synchronously reentrant callers share one in-flight
   * `Runtime.releaseObjectGroup`, any late confirmation wakes all active waiters, and each
   * caller's `timeout` and `signal` settle only its own wait without aborting sibling waiters.
   */
  release(options: WaitOptions = {}): Promise<void> {
    if (this.confirmed || this.session.closed) {
      this.markConfirmed();
      return Promise.resolve();
    }
    if (options.signal?.aborted) return Promise.reject(abortReason(options.signal));
    const waitTimeout = timeoutValue(options.timeout ?? 1000);
    if (!this.inFlight) {
      this.releaseStarted = true;
      // Register the shared attempt BEFORE calling `session.sendWith()` so synchronous reentrancy
      // inside `observe.onSend` joins this attempt instead of sending a second release command.
      let resolveAttempt!: () => void;
      let rejectAttempt!: (reason?: unknown) => void;
      const attempt = new Promise<void>((resolve, reject) => {
        resolveAttempt = resolve;
        rejectAttempt = reject;
      });
      // Prevent unhandledRejection if every caller cancels/times out before the shared send settles.
      void attempt.catch(() => {});
      this.inFlight = attempt;
      const onConfirmed = () => {
        if (this.inFlight === attempt) this.inFlight = undefined;
        resolveAttempt();
      };
      (this.confirmWaiters ??= new Set()).add(onConfirmed);
      const wireTimeout = Math.min(this.session.connection.timeout, Math.max(waitTimeout, 5000));
      const wireOptions: LedgerOptions = {
        timeout: wireTimeout,
        [ON_LATE_REPLY]: () => {
          this.markConfirmed();
        },
      };
      let wire: Promise<unknown>;
      try {
        wire = this.session.sendWith('Runtime.releaseObjectGroup', wireOptions, {
          objectGroup: this.name,
        });
      } catch (error) {
        this.confirmWaiters?.delete(onConfirmed);
        if (this.inFlight === attempt) this.inFlight = undefined;
        if (!this.confirmed) this.releaseStarted = false;
        rejectAttempt(error);
        return Promise.reject(error);
      }
      void wire.then(
        () => {
          this.confirmWaiters?.delete(onConfirmed);
          if (this.inFlight === attempt) this.inFlight = undefined;
          this.markConfirmed();
          resolveAttempt();
        },
        (error) => {
          this.confirmWaiters?.delete(onConfirmed);
          if (this.inFlight === attempt) this.inFlight = undefined;
          if (this.confirmed || this.session.closed) {
            this.markConfirmed();
            resolveAttempt();
            return;
          }
          rejectAttempt(error);
        },
      );
    }
    return bounded(
      this.inFlight,
      { timeout: waitTimeout, signal: options.signal },
      'Runtime.releaseObjectGroup',
    );
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release().catch(() => {});
  }
}

export function createObjectGroup(session: Session, name?: string): ObjectGroupScope {
  return new ObjectGroupScope(session, name);
}

interface WorldGuard {
  readonly key: string;
  readonly token: string;
  readonly mismatch: string;
}

interface StrictWorldEntry {
  readonly kind: 'strict';
  readonly contextId: number;
  readonly objectId: string;
  readonly objectGroup: string;
  guard?: WorldGuard;
  guardPending?: Promise<WorldGuard>;
}

interface GuardWorldEntry {
  readonly kind: 'guard';
  readonly contextId: number;
  readonly token: string;
}

interface NoneWorldEntry {
  readonly kind: 'none';
  readonly contextId: number;
}

type LightWorldEntry = GuardWorldEntry | NoneWorldEntry;
type WorldEntry = StrictWorldEntry | LightWorldEntry;

interface WorldSlot<E extends WorldEntry = WorldEntry> {
  readonly targetId?: string;
  readonly frameId: string;
  readonly worldName: string;
  readonly grantUniversalAccess: boolean;
  readonly verification: IsolatedWorldVerification;
  generation: number;
  recovering: boolean;
  cached?: E;
  pending?: Promise<E>;
  pendingObservers?: Set<IsolatedWorldObserver>;
}

const GUARD_KEY = '__nodriver_isolated_world_guard__';
const STAMP_GUARD_FN =
  'function(k,t){var d=Object.getOwnPropertyDescriptor(this,k);if(d&&typeof d.value==="string"&&d.value.startsWith("ndg:")&&!d.configurable&&!d.writable)return d.value;Object.defineProperty(this,k,{value:t,enumerable:false,configurable:false,writable:false});return t}';

const FAILED_BEFORE_CALL = Symbol('nodriver.failedBeforeCall');

/** Marks a `StaleElementError` as a context-mismatch error (retriable before user code runs). */
function worldMismatchError(message: string): StaleElementError {
  const error = new StaleElementError(message, { reason: 'world-mismatch' });
  Object.defineProperty(error, CONTEXT_GONE, { value: true });
  Object.defineProperty(error, FAILED_BEFORE_CALL, { value: true });
  return error;
}

function isWorldMismatchError(error: unknown): boolean {
  return !!error && typeof error === 'object' && FAILED_BEFORE_CALL in error;
}

function notifyObservers(
  observers: Iterable<IsolatedWorldObserver | undefined>,
  event: IsolatedWorldEvent,
  info: IsolatedWorldEventInfo,
): void {
  const seen = new Set<IsolatedWorldObserver>();
  for (const obs of observers) {
    if (!obs || seen.has(obs)) continue;
    seen.add(obs);
    try {
      obs(event, info);
    } catch {}
  }
}

function serializeEvaluateValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    return Object.is(value, -0) ? '-0' : String(value);
  const wrapped = JSON.stringify({ value });
  if (wrapped === '{}') return 'undefined';
  return wrapped
    .slice(9, -1)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function releaseRemoteObjects(
  response: {
    result?: Protocol.Runtime.RemoteObject;
    exceptionDetails?: Protocol.Runtime.ExceptionDetails;
  },
  session: Session,
): void {
  releaseObjects(session, [
    response.result?.objectId,
    response.exceptionDetails?.exception?.objectId,
  ]);
}

function throwEvaluationException(
  result: {
    result?: Protocol.Runtime.RemoteObject;
    exceptionDetails?: Protocol.Runtime.ExceptionDetails;
  },
  session: Session,
  mismatchSentinel?: string,
): void {
  const details = result.exceptionDetails;
  if (!details) return;
  releaseRemoteObjects(result, session);
  const description = formatExceptionDetails(details);
  if (mismatchSentinel && description.includes(mismatchSentinel))
    throw worldMismatchError('Isolated world execution context no longer matches');
  throw new EvaluationError(description);
}

const ID_START = /^[$_\p{ID_Start}]$/u;
const ID_CONTINUE = /^[$_\u200C\u200D\p{ID_Continue}]$/u;

function isLineTerminator(ch: number): boolean {
  return ch === 0x0a || ch === 0x0d || ch === 0x2028 || ch === 0x2029;
}

/** Splits an ECMA-262 HashbangComment (`#!` at byte 0) so it stays on line 1 of a wrapped Script. */
function splitHashbang(code: string): { hashbang: string; body: string } {
  if (!code.startsWith('#!')) return { hashbang: '', body: code };
  let p = 2;
  while (p < code.length) {
    const ch = code.charCodeAt(p);
    if (ch === 0x0d && code.charCodeAt(p + 1) === 0x0a) {
      p += 2;
      return { hashbang: code.slice(0, p), body: code.slice(p) };
    }
    if (isLineTerminator(ch)) {
      p++;
      return { hashbang: code.slice(0, p), body: code.slice(p) };
    }
    p++;
  }
  return { hashbang: `${code}\n`, body: '' };
}

function decodeUnicodeEscape(code: string, pos: number): { ch: string; next: number } | null {
  if (code[pos] !== '\\' || code[pos + 1] !== 'u') return null;
  if (code[pos + 2] === '{') {
    const close = code.indexOf('}', pos + 3);
    if (close === -1 || close === pos + 3) return null;
    const hex = code.slice(pos + 3, close);
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
    const cp = parseInt(hex, 16);
    if (cp > 0x10ffff) return null;
    return { ch: String.fromCodePoint(cp), next: close + 1 };
  }
  const hex = code.slice(pos + 2, pos + 6);
  if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return null;
  const cp = parseInt(hex, 16);
  return { ch: String.fromCodePoint(cp), next: pos + 6 };
}

function scanIdentifier(
  code: string,
  pos: number,
): { value: string; hasEscape: boolean; next: number } | null {
  let p = pos;
  let value = '';
  let hasEscape = false;
  while (p < code.length) {
    const test = value.length === 0 ? ID_START : ID_CONTINUE;
    if (code[p] === '\\') {
      const esc = decodeUnicodeEscape(code, p);
      if (!esc || !test.test(esc.ch)) break;
      hasEscape = true;
      value += esc.ch;
      p = esc.next;
    } else {
      const cp = code.codePointAt(p)!;
      const ch = String.fromCodePoint(cp);
      if (!test.test(ch)) break;
      value += ch;
      p += ch.length;
    }
  }
  return value.length > 0 ? { value, hasEscape, next: p } : null;
}

/**
 * Detects whether a JavaScript Script body (after any leading `#!` hashbang) starts with an
 * ECMA-262 `"use strict"` / `'use strict'` Directive Prologue, including Annex B HTML comments
 * (`<!--`, `-->`) and full Unicode-escaped identifier tokenization for ASI boundaries.
 */
function hasUseStrictDirective(code: string): boolean {
  const len = code.length;
  const skipWsAndComments = (start: number, lineStart: boolean) => {
    let p = start;
    let sawLineTerminator = false;
    let atLineStart = lineStart;
    while (p < len) {
      const ch = code.charCodeAt(p);
      if (isLineTerminator(ch)) {
        sawLineTerminator = true;
        atLineStart = true;
        p++;
      } else if (ch === 0x2f && code.charCodeAt(p + 1) === 0x2f) {
        p += 2;
        while (p < len && !isLineTerminator(code.charCodeAt(p))) p++;
      } else if (ch === 0x2f && code.charCodeAt(p + 1) === 0x2a) {
        p += 2;
        while (p + 1 < len && !(code.charCodeAt(p) === 0x2a && code.charCodeAt(p + 1) === 0x2f)) {
          if (isLineTerminator(code.charCodeAt(p))) {
            sawLineTerminator = true;
            atLineStart = true;
          }
          p++;
        }
        if (p + 1 >= len) return { pos: len, sawLineTerminator };
        p += 2;
      } else if (code.startsWith('<!--', p)) {
        p += 4;
        while (p < len && !isLineTerminator(code.charCodeAt(p))) p++;
      } else if (atLineStart && code.startsWith('-->', p)) {
        p += 3;
        while (p < len && !isLineTerminator(code.charCodeAt(p))) p++;
      } else if (/\s/.test(code[p]!)) {
        p++;
      } else {
        break;
      }
    }
    return { pos: p, sawLineTerminator };
  };
  const continuesExpression = (pos: number) => {
    if (pos >= len) return false;
    const ch = code[pos];
    const next = code[pos + 1];
    if (ch === '.') return !(next !== undefined && next >= '0' && next <= '9');
    if (
      ch === '[' ||
      ch === '(' ||
      ch === '`' ||
      ch === '?' ||
      ch === ',' ||
      ch === '*' ||
      ch === '/' ||
      ch === '%' ||
      ch === '<' ||
      ch === '>' ||
      ch === '=' ||
      ch === '&' ||
      ch === '|' ||
      ch === '^'
    ) {
      return true;
    }
    if (ch === '+' && next !== '+') return true;
    if (ch === '-' && next !== '-') return true;
    if (ch === '!' && next === '=') return true;
    const ident = scanIdentifier(code, pos);
    if (ident) {
      return !ident.hasEscape && (ident.value === 'in' || ident.value === 'instanceof');
    }
    return false;
  };
  let i = 0;
  let atLineStart = true;
  for (;;) {
    i = skipWsAndComments(i, atLineStart).pos;
    if (i >= len) return false;
    const quote = code[i];
    if (quote !== '"' && quote !== "'") return false;
    let end = i + 1;
    while (end < len) {
      const c = code[end];
      if (c === '\\') {
        end += code[end + 1] === '\r' && code[end + 2] === '\n' ? 3 : 2;
        continue;
      }
      if (c === '\n' || c === '\r') return false;
      if (c === quote) break;
      end++;
    }
    if (end >= len || code[end] !== quote) return false;
    const raw = code.slice(i, end + 1);
    const after = skipWsAndComments(end + 1, false);
    if (after.pos >= len) {
      return raw === '"use strict"' || raw === "'use strict'";
    }
    if (code[after.pos] === ';') {
      if (raw === '"use strict"' || raw === "'use strict'") return true;
      i = after.pos + 1;
      atLineStart = false;
      continue;
    }
    if (after.sawLineTerminator && !continuesExpression(after.pos)) {
      if (raw === '"use strict"' || raw === "'use strict'") return true;
      i = after.pos;
      atLineStart = true;
      continue;
    }
    return false;
  }
}

function buildGuardedFunctionExpression(
  fnSource: string,
  serializedArg: string,
  token: string,
  mismatch: string,
): string {
  const k = JSON.stringify(GUARD_KEY);
  const t = JSON.stringify(token);
  const m = JSON.stringify(mismatch);
  const check = `(()=>{try{return Object.getOwnPropertyDescriptor(globalThis,${k})?.value===${t}}catch{return false}})()`;
  return `${check}?(${fnSource})(${serializedArg}):(()=>{throw ${m}})()`;
}

function buildGuardedCodeExpression(
  code: string,
  token: string,
  mismatch: string,
  noEval: boolean,
): string {
  const k = JSON.stringify(GUARD_KEY);
  const t = JSON.stringify(token);
  const m = JSON.stringify(mismatch);
  const check = `(()=>{try{return Object.getOwnPropertyDescriptor(globalThis,${k})?.value===${t}}catch{return false}})()`;
  if (noEval) {
    const { hashbang, body } = splitHashbang(code);
    const prefix = hasUseStrictDirective(body) ? '"use strict";' : '';
    return `${hashbang}${prefix}if(!${check})throw ${m};{\n${body}\n}`;
  }
  return `${check}?(0,eval)(${JSON.stringify(code)}):(()=>{throw ${m}})()`;
}

function withLateExceptionCleanup(
  wait: WaitOptions,
  session: Session,
  disposeSignal: AbortSignal,
): LedgerOptions {
  return {
    ...withSignal(wait, disposeSignal),
    [ON_LATE_REPLY]: (result: unknown) => {
      releaseRemoteObjects(
        result as {
          result?: Protocol.Runtime.RemoteObject;
          exceptionDetails?: Protocol.Runtime.ExceptionDetails;
        },
        session,
      );
    },
  };
}

async function boundedOnSession<T>(
  promise: Promise<T>,
  wait: WaitOptions,
  session: Session,
  disposeSignal: AbortSignal,
  disposedError: () => Error,
  label: string,
): Promise<T> {
  if (session.closed) throw session.closedError();
  if (disposeSignal.aborted) throw disposedError();
  const endCtrl = new AbortController();
  const off = session.disconnected.on((err) => endCtrl.abort(err));
  const combined = wait.signal
    ? AbortSignal.any([wait.signal, disposeSignal, endCtrl.signal])
    : AbortSignal.any([disposeSignal, endCtrl.signal]);
  try {
    return await bounded(promise, { ...wait, signal: combined }, label);
  } catch (error) {
    if (session.closed) throw session.closeReason ?? error;
    if (disposeSignal.aborted) throw disposedError();
    throw error;
  } finally {
    off();
  }
}

/** Whether Chrome rejected our own isolated-world `globalThis` handle or context as gone/mismatched. */
function isWorldGone(error: unknown): boolean {
  return isWorldMismatchError(error) || isObjectGone(error);
}

/**
 * Whether a `Runtime.callFunctionOn` failure proves user code never started executing
 * (guard mismatch or pre-invocation context/object lookup failure, as opposed to
 * `Execution context was destroyed` / `Inspected target navigated or closed` which can occur
 * during or after callback execution).
 */
function isFailedBeforeCall(error: unknown): boolean {
  return (
    isWorldMismatchError(error) ||
    (error instanceof ProtocolError &&
      error.code === -32000 &&
      /Cannot find context with specified id|Could not find object with given id/i.test(
        error.protocolMessage,
      ))
  );
}

class TargetWorldRegistry {
  readonly slots = new Map<string, WorldSlot<LightWorldEntry>>();
  private readonly connection: Connection;
  private offDestroyed?: () => void;
  private offCrashed?: () => void;
  private offDisconnected?: () => void;

  constructor(connection: Connection) {
    this.connection = connection;
  }

  private ensureListeners(): void {
    if (this.offDisconnected || this.connection.closed) return;
    // Passive listeners only: never sends Target.setDiscoverTargets or *.enable.
    this.offDestroyed = this.connection.root.on('Target.targetDestroyed', ({ targetId }) => {
      this.invalidate({ targetId });
    });
    this.offCrashed = this.connection.root.on('Target.targetCrashed', ({ targetId }) => {
      this.invalidate({ targetId });
    });
    this.offDisconnected = this.connection.disconnected.on(() => {
      this.clearAll();
    });
  }

  private pruneListeners(): void {
    if (this.slots.size > 0) return;
    this.offDestroyed?.();
    this.offCrashed?.();
    this.offDisconnected?.();
    this.offDestroyed = undefined;
    this.offCrashed = undefined;
    this.offDisconnected = undefined;
  }

  slot(
    targetId: string,
    frameId: string,
    worldName: string,
    grantUniversalAccess: boolean,
    verification: 'guard' | 'none',
  ): WorldSlot<LightWorldEntry> {
    const key = `${targetId}\0${frameId}\0${worldName}\0${grantUniversalAccess ? 1 : 0}\0${verification}`;
    let slot = this.slots.get(key);
    if (!slot) {
      this.ensureListeners();
      slot = {
        targetId,
        frameId,
        worldName,
        grantUniversalAccess,
        verification,
        generation: 0,
        recovering: false,
      };
      this.slots.set(key, slot);
    }
    return slot;
  }

  invalidate(filter: InvalidateIsolatedWorldsFilter = {}, staleContextId?: number): void {
    for (const [key, slot] of this.slots) {
      if (filter.targetId !== undefined && slot.targetId !== filter.targetId) continue;
      if (filter.frameId !== undefined && slot.frameId !== filter.frameId) continue;
      if (filter.worldName !== undefined && slot.worldName !== filter.worldName) continue;
      if (staleContextId !== undefined) {
        if (slot.cached !== undefined && slot.cached.contextId !== staleContextId) continue;
        if (slot.cached === undefined && slot.pending) continue;
      }
      slot.generation++;
      slot.recovering = false;
      slot.cached = undefined;
      slot.pending = undefined;
      this.slots.delete(key);
    }
    this.pruneListeners();
  }

  private clearAll(): void {
    for (const slot of this.slots.values()) {
      slot.generation++;
      slot.recovering = false;
      slot.cached = undefined;
      slot.pending = undefined;
    }
    this.slots.clear();
    this.pruneListeners();
  }
}

const targetRegistries = new WeakMap<Connection, TargetWorldRegistry>();
const connectionDefaultWorldNames = new WeakMap<Connection, string>();

function targetRegistry(connection: Connection): TargetWorldRegistry {
  let registry = targetRegistries.get(connection);
  if (!registry) {
    registry = new TargetWorldRegistry(connection);
    targetRegistries.set(connection, registry);
  }
  return registry;
}

/**
 * Explicitly evicts target-scoped (`scope: 'target'`) isolated-world cache entries on `connection`
 * matching `filter` (or all entries on `connection` when `filter` is omitted). Sends no CDP
 * commands. Useful after raw `Page.navigate` / `Page.reload` or when `Target.setDiscoverTargets`
 * is not enabled on a bare `Connection`.
 */
export function invalidateIsolatedWorlds(
  connection: Connection,
  filter: InvalidateIsolatedWorldsFilter = {},
): void {
  targetRegistries.get(connection)?.invalidate(filter);
}

/**
 * Lightweight isolated-world helper for raw sessions (`attach: 'none'`).
 * Never calls `Runtime.enable`, `Page.enable` or `DOM.enable`, never falls back to the page's main
 * world, supports both session-bound (`scope: 'session'`) and cross-`TargetSession`
 * (`scope: 'target'`) caching with configurable `verification` (`'strict'`, `'guard'`, `'none'`),
 * and rebuilds/retries at most once on context loss.
 */
export class IsolatedWorld {
  readonly session: Session;
  readonly targetId?: string;
  readonly frameId: string;
  readonly worldName: string;
  readonly grantUniversalAccess: boolean;
  readonly scope: IsolatedWorldScope;
  readonly verification: IsolatedWorldVerification;
  private readonly onEvent?: IsolatedWorldObserver;
  private readonly localSlot?: WorldSlot;
  private disposeEpoch = 0;
  private disposeController = new AbortController();
  private offDisconnect?: () => void;

  constructor(session: Session, options: IsolatedWorldOptions = {}) {
    if (!session.id) throw new TypeError('IsolatedWorld requires a target session');
    const scope = options.scope ?? 'session';
    if (scope !== 'session' && scope !== 'target')
      throw new TypeError('IsolatedWorld scope must be "session" or "target"');
    const verification = options.verification ?? (scope === 'target' ? 'guard' : 'strict');
    if (verification !== 'strict' && verification !== 'guard' && verification !== 'none')
      throw new TypeError('IsolatedWorld verification must be "strict", "guard" or "none"');
    if (scope === 'target' && verification === 'strict')
      throw new TypeError(
        'IsolatedWorld verification "strict" requires scope "session" because RemoteObjectId handles are session-scoped',
      );
    let targetId: string | undefined;
    if (session instanceof TargetSession) {
      if (options.targetId !== undefined && options.targetId !== session.targetId)
        throw new TypeError('IsolatedWorld targetId does not match TargetSession.targetId');
      targetId = session.targetId;
    } else {
      if (scope === 'target' && !options.targetId)
        throw new TypeError(
          'IsolatedWorld scope "target" requires a TargetSession or explicit targetId',
        );
      targetId = options.targetId;
    }
    const frameId = options.frameId ?? targetId;
    if (!frameId) throw new TypeError('IsolatedWorld requires frameId for a plain Session');
    if (options.worldName !== undefined && !options.worldName)
      throw new TypeError('IsolatedWorld worldName must be a non-empty string');
    this.session = session;
    this.targetId = targetId;
    this.frameId = frameId;
    this.worldName = options.worldName ?? randomUUID();
    this.grantUniversalAccess = options.grantUniversalAccess ?? false;
    this.scope = scope;
    this.verification = verification;
    this.onEvent = options.onEvent;
    if (scope === 'session') {
      this.localSlot = {
        targetId,
        frameId,
        worldName: this.worldName,
        grantUniversalAccess: this.grantUniversalAccess,
        verification,
        generation: 0,
        recovering: false,
      };
    }
  }

  private activeSlot(): WorldSlot {
    if (this.localSlot) return this.localSlot;
    return targetRegistry(this.session.connection).slot(
      this.targetId!,
      this.frameId,
      this.worldName,
      this.grantUniversalAccess,
      this.verification as 'guard' | 'none',
    );
  }

  private releaseGroup(objectGroup: string): void {
    void releaseObjectGroup(this.session, objectGroup);
  }

  private disposedError(): Error {
    if (this.session.closed) return this.session.closedError();
    return new StaleElementError('IsolatedWorld was disposed', { reason: 'disposed' });
  }

  private initWait(disposeSignal: AbortSignal, callerTimeout?: number): () => WaitOptions {
    const cap = Math.min(this.session.connection.timeout, Math.max(callerTimeout ?? 0, 10_000));
    return budget(
      {
        timeout: cap,
        ...(this.scope === 'session' ? { signal: disposeSignal } : {}),
      },
      'isolated world creation',
    );
  }

  private createStrictEntry(
    slot: WorldSlot,
    epoch: number,
    disposeSignal: AbortSignal,
    callerTimeout?: number,
    callObserver?: IsolatedWorldObserver,
  ): Promise<StrictWorldEntry> {
    if (this.disposeEpoch !== epoch) return Promise.reject(this.disposedError());
    const observers = (slot.pendingObservers ??= new Set());
    if (this.onEvent) observers.add(this.onEvent);
    if (callObserver) observers.add(callObserver);
    if (!slot.pending) {
      this.offDisconnect ??= this.session.disconnected.on(() => this.dispose());
      const generation = slot.generation;
      const wasRecovering = slot.recovering;
      const batchObservers = observers;
      const initStep = this.initWait(disposeSignal, callerTimeout);
      const objectGroup = `nodriver-isolated-${randomUUID()}`;
      let groupAllocated = false;
      let groupReleased = false;
      const releaseOnce = () => {
        if (!groupAllocated || groupReleased) return;
        groupReleased = true;
        this.releaseGroup(objectGroup);
      };
      let settled = false;
      let task!: Promise<StrictWorldEntry>;
      task = (async (): Promise<StrictWorldEntry> => {
        try {
          const createParams = {
            frameId: this.frameId,
            worldName: this.worldName,
            ...(this.grantUniversalAccess ? { grantUniveralAccess: true } : {}),
          };
          const { executionContextId } = await this.session
            .sendWith('Page.createIsolatedWorld', initStep(), createParams)
            .catch((error: unknown) => {
              if (isFrameGone(error))
                throw new StaleElementError('Frame is detached', {
                  cause: error,
                  reason: 'frame-detached',
                });
              throw error;
            });
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          const globalRes = await this.session.sendWith(
            'Runtime.evaluate',
            {
              ...initStep(),
              [ON_LATE_REPLY]: (reply: Protocol.Runtime.EvaluateResponse) => {
                if (reply.exceptionDetails) releaseRemoteObjects(reply, this.session);
                if (reply.result?.objectId) {
                  groupAllocated = true;
                  releaseOnce();
                }
              },
            } as LedgerOptions,
            {
              expression: 'globalThis',
              contextId: executionContextId,
              objectGroup,
              generatePreview: false,
              silent: true,
              disableBreaks: true,
            },
          );
          if (globalRes.result.objectId) groupAllocated = true;
          if (this.disposeEpoch !== epoch) {
            if (globalRes.exceptionDetails) releaseRemoteObjects(globalRes, this.session);
            throw this.disposedError();
          }
          throwEvaluationException(globalRes, this.session);
          const global = globalRes.result;
          if (!global.objectId)
            throw new EvaluationError('Isolated world global object is unavailable');
          const isolated = parseRemoteObjectId(global.objectId);
          if (isolated.context !== executionContextId)
            throw worldMismatchError('Isolated world handle context does not match creation');
          const verifyGroup = `nodriver-isolated-verify-${randomUUID()}`;
          let verifyAllocated = false;
          try {
            const doc = await this.session.sendWith(
              'Runtime.callFunctionOn',
              {
                ...initStep(),
                [ON_LATE_REPLY]: (reply: Protocol.Runtime.CallFunctionOnResponse) => {
                  if (reply.exceptionDetails) releaseRemoteObjects(reply, this.session);
                  if (reply.result?.objectId) this.releaseGroup(verifyGroup);
                },
              } as LedgerOptions,
              {
                objectId: global.objectId,
                functionDeclaration: 'function(){return this.document}',
                objectGroup: verifyGroup,
                generatePreview: false,
                silent: true,
              },
            );
            if (doc.result.objectId) verifyAllocated = true;
            if (this.disposeEpoch !== epoch) {
              if (doc.exceptionDetails) releaseRemoteObjects(doc, this.session);
              throw this.disposedError();
            }
            throwEvaluationException(doc, this.session);
            if (!doc.result.objectId)
              throw worldMismatchError('Isolated world document is unavailable');
            const { node } = await this.session.sendWith('DOM.describeNode', initStep(), {
              objectId: doc.result.objectId,
            });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (node.frameId && node.frameId !== this.frameId)
              throw worldMismatchError('Isolated world resolved to a different frame');
            const { object: mainDoc } = await this.session.sendWith(
              'DOM.resolveNode',
              {
                ...initStep(),
                [ON_LATE_REPLY]: (reply: Protocol.DOM.ResolveNodeResponse) => {
                  if (reply.object?.objectId) this.releaseGroup(verifyGroup);
                },
              } as LedgerOptions,
              {
                backendNodeId: node.backendNodeId,
                objectGroup: verifyGroup,
              },
            );
            if (mainDoc.objectId) verifyAllocated = true;
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (!mainDoc.objectId)
              throw worldMismatchError('Main-world document is unavailable during verification');
            const main = parseRemoteObjectId(mainDoc.objectId);
            if (main.isolate !== isolated.isolate || main.context === isolated.context)
              throw worldMismatchError(
                'Isolated world handle collided with the main-world execution context',
              );
            const { executionContextId: confirmedId } = await this.session
              .sendWith('Page.createIsolatedWorld', initStep(), createParams)
              .catch((error: unknown) => {
                if (isFrameGone(error))
                  throw new StaleElementError('Frame is detached', {
                    cause: error,
                    reason: 'frame-detached',
                  });
                throw error;
              });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (confirmedId !== executionContextId)
              throw worldMismatchError(
                'Isolated world handle does not match the requested worldName',
              );
            const { object: confirmedDoc } = await this.session.sendWith(
              'DOM.resolveNode',
              {
                ...initStep(),
                [ON_LATE_REPLY]: (reply: Protocol.DOM.ResolveNodeResponse) => {
                  if (reply.object?.objectId) this.releaseGroup(verifyGroup);
                },
              } as LedgerOptions,
              {
                backendNodeId: node.backendNodeId,
                executionContextId: confirmedId,
                objectGroup: verifyGroup,
              },
            );
            if (confirmedDoc.objectId) verifyAllocated = true;
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (!confirmedDoc.objectId)
              throw worldMismatchError('Isolated world document confirmation is unavailable');
            const confirmed = parseRemoteObjectId(confirmedDoc.objectId);
            if (confirmed.isolate !== isolated.isolate || confirmed.context !== isolated.context)
              throw worldMismatchError(
                'Isolated world confirmation resolved to a different context',
              );
            const sameWorld = await this.session.sendWith('Runtime.callFunctionOn', initStep(), {
              objectId: doc.result.objectId,
              functionDeclaration: 'function(other){return this === other}',
              arguments: [{ objectId: confirmedDoc.objectId }],
              returnByValue: true,
              silent: true,
            });
            releaseRemoteObjects(sameWorld, this.session);
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (sameWorld.exceptionDetails || sameWorld.result.value !== true)
              throw worldMismatchError('Isolated world handle does not match the named world');
          } catch (error) {
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (isNodeGone(error) || isWorldMismatch(error))
              throw worldMismatchError(
                'Isolated world document or world changed during verification',
              );
            throw error;
          } finally {
            if (verifyAllocated) this.releaseGroup(verifyGroup);
          }
          const entry: StrictWorldEntry = {
            kind: 'strict',
            contextId: executionContextId,
            objectId: global.objectId,
            objectGroup,
          };
          settled = true;
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          if (slot.pending === task && slot.generation === generation) {
            slot.cached = entry;
            slot.recovering = false;
            slot.pending = undefined;
            slot.pendingObservers = undefined;
            notifyObservers(batchObservers, wasRecovering ? 'recovered' : 'created', {
              targetId: this.targetId,
              frameId: this.frameId,
              worldName: this.worldName,
              contextId: executionContextId,
            });
            return entry;
          }
          throw worldMismatchError('Isolated world was invalidated during creation');
        } catch (error) {
          settled = true;
          if (slot.pending === task) {
            slot.pending = undefined;
            slot.pendingObservers = undefined;
          }
          releaseOnce();
          if (this.disposeEpoch === epoch) {
            notifyObservers(batchObservers, 'create-failed', {
              targetId: this.targetId,
              frameId: this.frameId,
              worldName: this.worldName,
              error,
            });
          }
          throw error;
        }
      })();
      if (!settled) slot.pending = task;
      void task.catch(() => {});
      return task;
    }
    return slot.pending as Promise<StrictWorldEntry>;
  }

  private createGuardEntry(
    slot: WorldSlot,
    epoch: number,
    disposeSignal: AbortSignal,
    callerTimeout?: number,
    callObserver?: IsolatedWorldObserver,
  ): Promise<GuardWorldEntry> {
    if (this.disposeEpoch !== epoch) return Promise.reject(this.disposedError());
    const observers = (slot.pendingObservers ??= new Set());
    if (this.onEvent) observers.add(this.onEvent);
    if (callObserver) observers.add(callObserver);
    if (!slot.pending) {
      if (this.scope === 'session') {
        this.offDisconnect ??= this.session.disconnected.on(() => this.dispose());
      }
      const generation = slot.generation;
      const wasRecovering = slot.recovering;
      const batchObservers = observers;
      const session = this.session;
      const initStep = this.initWait(disposeSignal, callerTimeout);
      const objectGroup = `nodriver-isolated-guard-${randomUUID()}`;
      let groupAllocated = false;
      let groupReleased = false;
      const releaseOnce = () => {
        if (!groupAllocated || groupReleased) return;
        groupReleased = true;
        void releaseObjectGroup(session, objectGroup);
      };
      let settled = false;
      let task!: Promise<GuardWorldEntry>;
      task = (async (): Promise<GuardWorldEntry> => {
        try {
          const createParams = {
            frameId: this.frameId,
            worldName: this.worldName,
            ...(this.grantUniversalAccess ? { grantUniveralAccess: true } : {}),
          };
          const { executionContextId } = await session
            .sendWith('Page.createIsolatedWorld', initStep(), createParams)
            .catch((error: unknown) => {
              if (isFrameGone(error))
                throw new StaleElementError('Frame is detached', {
                  cause: error,
                  reason: 'frame-detached',
                });
              throw error;
            });
          if (this.scope === 'session' && this.disposeEpoch !== epoch) throw this.disposedError();
          const globalRes = await session.sendWith(
            'Runtime.evaluate',
            {
              ...initStep(),
              [ON_LATE_REPLY]: (reply: Protocol.Runtime.EvaluateResponse) => {
                if (reply.exceptionDetails) releaseRemoteObjects(reply, session);
                if (reply.result?.objectId) {
                  groupAllocated = true;
                  releaseOnce();
                }
              },
            } as LedgerOptions,
            {
              expression: 'globalThis',
              contextId: executionContextId,
              objectGroup,
              generatePreview: false,
              silent: true,
              disableBreaks: true,
            },
          );
          if (globalRes.result.objectId) groupAllocated = true;
          if (this.scope === 'session' && this.disposeEpoch !== epoch) {
            if (globalRes.exceptionDetails) releaseRemoteObjects(globalRes, session);
            throw this.disposedError();
          }
          throwEvaluationException(globalRes, session);
          const global = globalRes.result;
          if (!global.objectId)
            throw new EvaluationError('Isolated world global object is unavailable');
          const isolated = parseRemoteObjectId(global.objectId);
          if (isolated.context !== executionContextId)
            throw worldMismatchError('Isolated world handle context does not match creation');
          const { executionContextId: confirmedId } = await session
            .sendWith('Page.createIsolatedWorld', initStep(), createParams)
            .catch((error: unknown) => {
              if (isFrameGone(error))
                throw new StaleElementError('Frame is detached', {
                  cause: error,
                  reason: 'frame-detached',
                });
              throw error;
            });
          if (this.scope === 'session' && this.disposeEpoch !== epoch) throw this.disposedError();
          if (confirmedId !== executionContextId)
            throw worldMismatchError(
              'Isolated world handle does not match the requested worldName',
            );
          const proposedToken = `ndg:${randomUUID()}`;
          const stamp = await session.sendWith('Runtime.callFunctionOn', initStep(), {
            objectId: global.objectId,
            functionDeclaration: STAMP_GUARD_FN,
            arguments: [{ value: GUARD_KEY }, { value: proposedToken }],
            returnByValue: true,
            silent: true,
          });
          if (this.scope === 'session' && this.disposeEpoch !== epoch) {
            releaseRemoteObjects(stamp, session);
            throw this.disposedError();
          }
          throwEvaluationException(stamp, session);
          const token = stamp.result.value;
          if (typeof token !== 'string' || !token.startsWith('ndg:'))
            throw worldMismatchError('Isolated world guard token could not be initialized');
          const entry: GuardWorldEntry = {
            kind: 'guard',
            contextId: executionContextId,
            token,
          };
          settled = true;
          if (this.scope === 'session' && this.disposeEpoch !== epoch) throw this.disposedError();
          if (slot.pending === task && slot.generation === generation) {
            slot.cached = entry;
            slot.recovering = false;
            slot.pending = undefined;
            slot.pendingObservers = undefined;
            notifyObservers(batchObservers, wasRecovering ? 'recovered' : 'created', {
              targetId: this.targetId,
              frameId: this.frameId,
              worldName: this.worldName,
              contextId: executionContextId,
            });
            return entry;
          }
          throw worldMismatchError('Isolated world was invalidated during creation');
        } catch (error) {
          settled = true;
          if (slot.pending === task) {
            slot.pending = undefined;
            slot.pendingObservers = undefined;
          }
          if (this.scope !== 'session' || this.disposeEpoch === epoch) {
            notifyObservers(batchObservers, 'create-failed', {
              targetId: this.targetId,
              frameId: this.frameId,
              worldName: this.worldName,
              error,
            });
          }
          throw error;
        } finally {
          releaseOnce();
        }
      })();
      if (!settled) slot.pending = task;
      void task.catch(() => {});
      return task;
    }
    return slot.pending as Promise<GuardWorldEntry>;
  }

  private createNoneEntry(
    slot: WorldSlot,
    epoch: number,
    disposeSignal: AbortSignal,
    callerTimeout?: number,
    callObserver?: IsolatedWorldObserver,
  ): Promise<NoneWorldEntry> {
    if (this.disposeEpoch !== epoch) return Promise.reject(this.disposedError());
    const observers = (slot.pendingObservers ??= new Set());
    if (this.onEvent) observers.add(this.onEvent);
    if (callObserver) observers.add(callObserver);
    if (!slot.pending) {
      if (this.scope === 'session') {
        this.offDisconnect ??= this.session.disconnected.on(() => this.dispose());
      }
      const generation = slot.generation;
      const wasRecovering = slot.recovering;
      const batchObservers = observers;
      const session = this.session;
      const initStep = this.initWait(disposeSignal, callerTimeout);
      let settled = false;
      let task!: Promise<NoneWorldEntry>;
      task = (async (): Promise<NoneWorldEntry> => {
        try {
          const { executionContextId } = await session
            .sendWith('Page.createIsolatedWorld', initStep(), {
              frameId: this.frameId,
              worldName: this.worldName,
              ...(this.grantUniversalAccess ? { grantUniveralAccess: true } : {}),
            })
            .catch((error: unknown) => {
              if (isFrameGone(error))
                throw new StaleElementError('Frame is detached', {
                  cause: error,
                  reason: 'frame-detached',
                });
              throw error;
            });
          if (this.scope === 'session' && this.disposeEpoch !== epoch) throw this.disposedError();
          const entry: NoneWorldEntry = {
            kind: 'none',
            contextId: executionContextId,
          };
          settled = true;
          if (slot.pending === task && slot.generation === generation) {
            slot.cached = entry;
            slot.recovering = false;
            slot.pending = undefined;
            slot.pendingObservers = undefined;
            notifyObservers(batchObservers, wasRecovering ? 'recovered' : 'created', {
              targetId: this.targetId,
              frameId: this.frameId,
              worldName: this.worldName,
              contextId: executionContextId,
            });
            return entry;
          }
          throw worldMismatchError('Isolated world was invalidated during creation');
        } catch (error) {
          settled = true;
          if (slot.pending === task) {
            slot.pending = undefined;
            slot.pendingObservers = undefined;
          }
          if (this.scope !== 'session' || this.disposeEpoch === epoch) {
            notifyObservers(batchObservers, 'create-failed', {
              targetId: this.targetId,
              frameId: this.frameId,
              worldName: this.worldName,
              error,
            });
          }
          throw error;
        }
      })();
      if (!settled) slot.pending = task;
      void task.catch(() => {});
      return task;
    }
    return slot.pending as Promise<NoneWorldEntry>;
  }

  private async verifyStrictEntry(
    slot: WorldSlot,
    entry: StrictWorldEntry,
    options: LedgerOptions,
  ): Promise<boolean> {
    try {
      const res = await this.session.sendWith('Runtime.callFunctionOn', options, {
        objectId: entry.objectId,
        functionDeclaration: 'function(){return 1}',
        returnByValue: true,
        silent: true,
      });
      releaseRemoteObjects(res, this.session);
      return true;
    } catch (error) {
      if (!isWorldGone(error)) throw error;
      this.markEntryLost(slot, entry);
      return false;
    }
  }

  private async verifyGuardEntry(
    slot: WorldSlot,
    entry: GuardWorldEntry,
    step: () => WaitOptions,
    epoch: number,
    disposeSignal: AbortSignal,
  ): Promise<boolean> {
    try {
      const mismatch = `__nodriver_iso_mismatch_${randomUUID()}__`;
      const k = JSON.stringify(GUARD_KEY);
      const t = JSON.stringify(entry.token);
      const m = JSON.stringify(mismatch);
      const res = await this.session.sendWith(
        'Runtime.evaluate',
        withLateExceptionCleanup(step(), this.session, disposeSignal),
        {
          expression: `(()=>{try{if(Object.getOwnPropertyDescriptor(globalThis,${k})?.value!==${t})throw 0}catch{throw ${m}};return 1})()`,
          contextId: entry.contextId,
          returnByValue: true,
          silent: true,
          disableBreaks: true,
        },
      );
      if (this.disposeEpoch !== epoch) {
        releaseRemoteObjects(res, this.session);
        throw this.disposedError();
      }
      throwEvaluationException(res, this.session, mismatch);
      return true;
    } catch (error) {
      if (this.disposeEpoch !== epoch) throw this.disposedError();
      if (!isWorldGone(error)) throw error;
      this.markEntryLost(slot, entry);
      return false;
    }
  }

  private async ensureStrictGuard(
    entry: StrictWorldEntry,
    step: () => WaitOptions,
    disposeSignal: AbortSignal,
  ): Promise<WorldGuard> {
    if (entry.guard) return entry.guard;
    const wait = step();
    if (!entry.guardPending) {
      const proposedToken = `ndg:${randomUUID()}`;
      const mismatch = `__nodriver_iso_mismatch_${randomUUID()}__`;
      const initStep = this.initWait(disposeSignal, wait.timeout);
      let settled = false;
      let task!: Promise<WorldGuard>;
      task = (async () => {
        try {
          const res = await this.session.sendWith('Runtime.callFunctionOn', initStep(), {
            objectId: entry.objectId,
            functionDeclaration: STAMP_GUARD_FN,
            arguments: [{ value: GUARD_KEY }, { value: proposedToken }],
            returnByValue: true,
            silent: true,
          });
          throwEvaluationException(res, this.session);
          const token = res.result.value;
          if (typeof token !== 'string' || !token.startsWith('ndg:'))
            throw worldMismatchError('Isolated world guard token is unavailable');
          const guard: WorldGuard = { key: GUARD_KEY, token, mismatch };
          entry.guard = guard;
          settled = true;
          if (entry.guardPending === task) entry.guardPending = undefined;
          return guard;
        } catch (error) {
          settled = true;
          if (entry.guardPending === task) entry.guardPending = undefined;
          throw error;
        }
      })();
      if (!settled) entry.guardPending = task;
      void task.catch(() => {});
      return boundedOnSession(
        task,
        wait,
        this.session,
        disposeSignal,
        () => this.disposedError(),
        'isolated world guard',
      );
    }
    return boundedOnSession(
      entry.guardPending,
      wait,
      this.session,
      disposeSignal,
      () => this.disposedError(),
      'isolated world guard',
    );
  }

  private async acquire(
    slot: WorldSlot,
    step: () => WaitOptions,
    verify: boolean,
    epoch: number,
    disposeSignal: AbortSignal,
    callObserver?: IsolatedWorldObserver,
  ): Promise<WorldEntry> {
    if (this.session.closed) throw this.session.closedError();
    if (this.disposeEpoch !== epoch) throw this.disposedError();
    const wait = step();
    const cached = slot.cached;
    if (cached) {
      if (!verify || cached.kind === 'none') return cached;
      if (cached.kind === 'strict') {
        if (
          await this.verifyStrictEntry(
            slot,
            cached,
            withLateExceptionCleanup(wait, this.session, disposeSignal),
          )
        ) {
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          return cached;
        }
      } else {
        if (await this.verifyGuardEntry(slot, cached, step, epoch, disposeSignal)) {
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          return cached;
        }
      }
    }
    if (this.disposeEpoch !== epoch) throw this.disposedError();
    const createWait = step();
    const creating: Promise<WorldEntry> =
      this.verification === 'strict'
        ? this.createStrictEntry(slot, epoch, disposeSignal, createWait.timeout, callObserver)
        : this.verification === 'guard'
          ? this.createGuardEntry(slot, epoch, disposeSignal, createWait.timeout, callObserver)
          : this.createNoneEntry(slot, epoch, disposeSignal, createWait.timeout, callObserver);
    const entry = await boundedOnSession(
      creating,
      createWait,
      this.session,
      disposeSignal,
      () => this.disposedError(),
      'isolated world creation',
    );
    if (this.disposeEpoch !== epoch) throw this.disposedError();
    return entry;
  }

  private markEntryLost(slot: WorldSlot, stale: WorldEntry): void {
    if (slot.cached !== stale) return;
    slot.generation++;
    slot.recovering = true;
    slot.cached = undefined;
    slot.pending = undefined;
    if (stale.kind === 'strict') this.releaseGroup(stale.objectGroup);
  }

  /**
   * Resolves (or verifies and reuses) this isolated world's numeric execution context ID without
   * enabling `Runtime`, `Page` or `DOM`.
   *
   * With `verification: 'none'`, a warm cache returns in **0 CDP roundtrips** (ideal for passing
   * `executionContextId` to `DOM.resolveNode`). With `'strict'` or `'guard'`, cold bind verifies
   * the world (and seeds the guard token in `'guard'` mode) before returning, and warm cache hits
   * verify in 1 roundtrip.
   *
   * Note on lifetime: a numeric `executionContextId` is a point-in-time snapshot valid only while
   * the current document and renderer process stay alive; Chrome may reuse numeric IDs across
   * process boundaries after navigation. Prefer `evaluate()` when you want handle- or guard-bound
   * execution without exposing a numeric ID.
   */
  async context(options: IsolatedRunOptions = {}): Promise<number> {
    if (this.session.closed) throw this.session.closedError();
    if (options.signal?.aborted) throw abortReason(options.signal);
    const epoch = this.disposeEpoch;
    const disposeSignal = this.disposeController.signal;
    const retry = options.retryOnContextGone ?? true;
    const step = budget(options, 'isolated world creation');
    for (let attempt = 0; ; attempt++) {
      const slot = this.activeSlot();
      let entry: WorldEntry | undefined;
      try {
        entry = await this.acquire(slot, step, true, epoch, disposeSignal, options.onEvent);
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        return entry.contextId;
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        const siblingDetached =
          !entry &&
          this.scope === 'target' &&
          !this.session.closed &&
          error instanceof SessionEndedError;
        if (!isWorldGone(error) && !siblingDetached) throw error;
        if (entry) this.markEntryLost(slot, entry);
        else if (isWorldGone(error)) slot.recovering = true;
        if (!retry || attempt > 0) throw error;
      }
    }
  }

  /**
   * Drops the cached execution context for this world (including the shared connection-level slot
   * when `scope: 'target'`). When `staleContextId` is given, only drops it if the cache still holds
   * that ID (so concurrent callers do not clobber a freshly rebuilt world).
   */
  invalidate(staleContextId?: number): void {
    if (!this.localSlot) {
      targetRegistries.get(this.session.connection)?.invalidate(
        {
          targetId: this.targetId,
          frameId: this.frameId,
          worldName: this.worldName,
        },
        staleContextId,
      );
      return;
    }
    const slot = this.localSlot;
    if (staleContextId !== undefined) {
      if (slot.cached !== undefined && slot.cached.contextId !== staleContextId) return;
      if (slot.cached === undefined && slot.pending) return;
    }
    const previous = slot.cached;
    slot.generation++;
    slot.recovering = false;
    slot.cached = undefined;
    slot.pending = undefined;
    if (previous?.kind === 'strict') this.releaseGroup(previous.objectGroup);
  }

  /**
   * Disposes this `IsolatedWorld` wrapper: immediately settles any pending waits on this instance
   * (including active `run()` callbacks and in-flight `evaluate()` commands) with
   * `StaleElementError`, removes its disconnect listener, and—for `scope: 'session'`—clears cached
   * state and releases its remote object handle. For `scope: 'target'`, the shared connection-level
   * target cache is preserved for subsequent `TargetSession`s (use `invalidate()` or
   * `invalidateIsolatedWorlds()` for explicit eviction).
   */
  dispose(): void {
    const controller = this.disposeController;
    this.disposeEpoch++;
    this.disposeController = new AbortController();
    if (this.localSlot) this.invalidate();
    this.offDisconnect?.();
    this.offDisconnect = undefined;
    controller.abort(this.disposedError());
  }

  /**
   * Runs `task` with an isolated-world execution context ID and a shared deadline stepper.
   * With `verification: 'none'`, warm calls enter `task` in **0 CDP roundtrips** while retaining
   * automatic 1-retry rebuild if `task` (such as `DOM.resolveNode`) rejects with `isContextGone`.
   */
  async run<T>(
    task: (contextId: number, step: () => WaitOptions) => Promise<T>,
    options: IsolatedRunOptions = {},
  ): Promise<T> {
    const epoch = this.disposeEpoch;
    const disposeSignal = this.disposeController.signal;
    const step = budget(options, 'isolated world operation');
    const retry = options.retryOnContextGone ?? true;
    for (let attempt = 0; ; attempt++) {
      const slot = this.activeSlot();
      let entry: WorldEntry | undefined;
      try {
        entry = await this.acquire(slot, step, true, epoch, disposeSignal, options.onEvent);
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        step();
        const running = new Promise<T>((resolve, reject) => {
          try {
            resolve(task(entry!.contextId, step));
          } catch (error) {
            reject(error);
          }
        });
        void running.catch(() => {});
        const result = await bounded(
          running,
          withSignal(step(), disposeSignal),
          'isolated world operation',
        );
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        return result;
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        const siblingDetached =
          !entry &&
          this.scope === 'target' &&
          !this.session.closed &&
          error instanceof SessionEndedError;
        const gone = entry
          ? isContextGone(error) || isWorldMismatchError(error)
          : isWorldGone(error) || siblingDetached;
        if (!gone) throw error;
        if (entry) this.markEntryLost(slot, entry);
        else if (isWorldGone(error)) slot.recovering = true;
        if (!retry || attempt > 0) throw error;
      }
    }
  }

  /**
   * Runs `task` with a fresh managed `ObjectGroupScope` and this isolated world's execution
   * context ID, releasing the object group automatically on completion, error, cancellation, or
   * retry.
   */
  async withObjectGroup<T>(
    task: (scope: ObjectGroupScope, contextId: number, step: () => WaitOptions) => Promise<T>,
    options: IsolatedRunOptions & { objectGroup?: string } = {},
  ): Promise<T> {
    if (options.objectGroup !== undefined && !options.objectGroup)
      throw new TypeError('objectGroup name must be a non-empty string');
    const disposeSignal = this.disposeController.signal;
    let activeScope: ObjectGroupScope | undefined;
    try {
      return await this.run(async (contextId, step) => {
        const scope = new ObjectGroupScope(this.session, options.objectGroup);
        activeScope = scope;
        const onDispose = () => {
          void scope.release().catch(() => {});
        };
        disposeSignal.addEventListener('abort', onDispose, { once: true });
        try {
          return await task(scope, contextId, step);
        } finally {
          disposeSignal.removeEventListener('abort', onDispose);
          void scope.release().catch(() => {});
        }
      }, options);
    } finally {
      void activeScope?.release().catch(() => {});
    }
  }

  /**
   * Resolves a batch of `backendNodeId`s into this isolated world in chunks, invokes synchronous
   * `fn(el, arg)` on every resolved node in one `Runtime.callFunctionOn` per chunk, and registers
   * each chunk's `ObjectGroupScope` release on the connection without delaying caller deadlines.
   * Never enables `DOM`, `Runtime`, or `Page`, never shadows page globals in `fn`'s lexical scope,
   * and rejects `async` functions or Promise-returning callbacks with `TypeError`.
   *
   * Respects `verification` (`'strict'` binds to `entry.objectId`, `'guard'` verifies the world
   * guard token before invoking `fn`, `'none'` executes directly). Rebuilds and retries once on
   * context loss only before any chunk's user callback has executed (unless `retryOnContextGone:
   * false`), so already-completed chunks are never replayed or mixed across documents.
   */
  async callOnNodes<T = unknown, A = unknown>(
    backendNodeIds: readonly Protocol.DOM.BackendNodeId[],
    fn: (element: Element, arg: A) => SyncNodeCallResult<T>,
    arg?: A,
    options: IsolatedCallOnNodesOptions = {},
  ): Promise<Array<NodeCallResult<T>>> {
    if (!Array.isArray(backendNodeIds)) throw new TypeError('backendNodeIds must be an array');
    if (typeof fn !== 'function') throw new TypeError('callOnNodes requires a function');
    if (fn.constructor?.name === 'AsyncFunction')
      throw new TypeError(
        'callOnNodes requires a synchronous function (async functions are not supported)',
      );
    for (const id of backendNodeIds) positiveInt(id, 'backendNodeId');
    const chunkSize = positiveInt(options.chunkSize ?? 128, 'chunkSize');
    const step = budget(options, 'isolated world callOnNodes');
    if (this.session.closed) throw this.session.closedError();
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (!backendNodeIds.length) return [];

    const epoch = this.disposeEpoch;
    const disposeSignal = this.disposeController.signal;
    const retry = options.retryOnContextGone ?? true;
    const requireConnected = options.requireConnected ?? true;
    const skipMissingNodes = options.skipMissingNodes ?? true;
    const callFnExtras = {
      ...(options.silent !== undefined ? { silent: options.silent } : {}),
      ...(options.throwOnSideEffect !== undefined
        ? { throwOnSideEffect: options.throwOnSideEffect }
        : {}),
      ...(options.userGesture !== undefined ? { userGesture: options.userGesture } : {}),
    };
    const encodedArg = encodeCallArgument(arg);
    const fnSource = fn.toString();

    for (let attempt = 0; ; attempt++) {
      const slot = this.activeSlot();
      let entry: WorldEntry | undefined;
      // True once a chunk's `Runtime.callFunctionOn` has been sent and neither failed pre-call nor
      // confirmed zero callback invocations (e.g. all nodes in the chunk were detached).
      let callbackInvokedOrUncertain = false;
      try {
        const acquired = await this.acquire(
          slot,
          step,
          false,
          epoch,
          disposeSignal,
          options.onEvent,
        );
        entry = acquired;
        if (this.disposeEpoch !== epoch) throw this.disposedError();

        const mismatch =
          acquired.kind === 'guard' ? `__nodriver_iso_mismatch_${randomUUID()}__` : undefined;
        const asyncSentinel = `__nodriver_iso_async_${randomUUID()}__`;
        const guardCheck =
          acquired.kind === 'guard'
            ? `try{if(Object.getOwnPropertyDescriptor(globalThis,${JSON.stringify(GUARD_KEY)})?.value!==${JSON.stringify(acquired.token)})throw 0}catch{throw ${JSON.stringify(mismatch!)}};`
            : '';
        // Evaluate `${fnSource}` as an argument to the outer arrow IIFE in global scope so ZERO
        // wrapper bindings (not even `__nd_a`, `__nd_fn` or `arguments`) exist in `fn`'s lexical
        // environment, while using no `eval` so V8 `throwOnSideEffect: true` works cleanly.
        // Attach a no-op rejection handler on native Promises before throwing `asyncSentinel` so a
        // rejected Promise returned by a sync callback never leaks an unhandledRejection in V8.
        const functionDeclaration = `((__nd_fn)=>function(...__nd_a){${guardCheck}const __nd_arg=__nd_a[0],__nd_out=[];for(let __nd_i=1;__nd_i<__nd_a.length;__nd_i++){const __nd_el=__nd_a[__nd_i];if(!__nd_el${requireConnected ? '||!__nd_el.isConnected' : ''}){__nd_out.push({ok:false,stale:true});continue;}const __nd_v=__nd_fn(__nd_el,__nd_arg);if(__nd_v!==null&&(typeof __nd_v==="object"||typeof __nd_v==="function")&&typeof __nd_v.then==="function"){try{Promise.prototype.then.call(__nd_v,undefined,()=>{});}catch{}throw ${JSON.stringify(asyncSentinel)};}__nd_out.push({ok:true,value:__nd_v});}return __nd_out;})(${fnSource})`;

        const results: Array<NodeCallResult<T>> = [];
        for (let offset = 0; offset < backendNodeIds.length; offset += chunkSize) {
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          const chunk = backendNodeIds.slice(offset, offset + chunkSize);
          const group = new ObjectGroupScope(this.session);
          try {
            const resolveWait: LedgerOptions = {
              ...withSignal(step(), disposeSignal),
              [ON_LATE_REPLY]: (reply) => {
                const lateId = (reply as Protocol.DOM.ResolveNodeResponse | undefined)?.object
                  ?.objectId;
                if (lateId && !this.session.closed)
                  void this.session
                    .sendWith('Runtime.releaseObject', { timeout: 1000 }, { objectId: lateId })
                    .catch(() => {});
              },
            };
            const resolved = await Promise.all(
              chunk.map(async (backendNodeId) => {
                try {
                  const { object } = await this.session.sendWith('DOM.resolveNode', resolveWait, {
                    backendNodeId,
                    executionContextId: acquired.contextId,
                    objectGroup: group.name,
                  });
                  if (group.releasing && object.objectId && !this.session.closed) {
                    void this.session
                      .sendWith(
                        'Runtime.releaseObject',
                        { timeout: 1000 },
                        { objectId: object.objectId },
                      )
                      .catch(() => {});
                    return undefined;
                  }
                  if (!object.objectId) {
                    if (skipMissingNodes) return undefined;
                    throw new StaleElementError('Node no longer exists', {
                      reason: 'node-detached',
                    });
                  }
                  return object.objectId;
                } catch (error) {
                  if (isNodeGone(error)) {
                    if (skipMissingNodes) return undefined;
                    throw new StaleElementError('Node no longer exists', {
                      cause: error,
                      reason: 'node-detached',
                    });
                  }
                  throw error;
                }
              }),
            );
            if (this.disposeEpoch !== epoch) throw this.disposedError();

            const validIndices: number[] = [];
            const objectIds: string[] = [];
            for (let i = 0; i < resolved.length; i++) {
              const id = resolved[i];
              if (id) {
                validIndices.push(i);
                objectIds.push(id);
              }
            }
            const chunkResults: Array<NodeCallResult<T>> = chunk.map((backendNodeId) => ({
              ok: false,
              backendNodeId,
              stale: true,
            }));

            if (objectIds.length) {
              const prevInvoked: boolean = callbackInvokedOrUncertain;
              callbackInvokedOrUncertain = true;
              let res: Protocol.Runtime.CallFunctionOnResponse;
              try {
                res = await this.session.sendWith(
                  'Runtime.callFunctionOn',
                  withLateExceptionCleanup(step(), this.session, disposeSignal),
                  {
                    ...(acquired.kind === 'strict'
                      ? { objectId: acquired.objectId }
                      : { executionContextId: acquired.contextId }),
                    objectGroup: group.name,
                    functionDeclaration,
                    arguments: [encodedArg, ...objectIds.map((objectId) => ({ objectId }))],
                    returnByValue: true,
                    ...callFnExtras,
                  },
                );
              } catch (error) {
                if (!prevInvoked && isFailedBeforeCall(error)) callbackInvokedOrUncertain = false;
                throw error;
              }
              if (this.disposeEpoch !== epoch) {
                releaseRemoteObjects(res, this.session);
                throw this.disposedError();
              }
              if (res.exceptionDetails) {
                const desc = formatExceptionDetails(res.exceptionDetails);
                if (desc.includes(asyncSentinel)) {
                  releaseRemoteObjects(res, this.session);
                  throw new TypeError(
                    'callOnNodes callback must return a synchronous value, not a Promise',
                  );
                }
              }
              try {
                throwEvaluationException(res, this.session, mismatch);
              } catch (error) {
                if (!prevInvoked && isFailedBeforeCall(error)) callbackInvokedOrUncertain = false;
                throw error;
              }
              const payload = decodeRemoteValue(res.result) as Array<
                { ok: true; value: T } | { ok: false; stale: true }
              >;
              let chunkInvoked = false;
              for (let j = 0; j < validIndices.length; j++) {
                const idx = validIndices[j]!;
                const item = payload[j];
                if (item?.ok) {
                  chunkInvoked = true;
                  chunkResults[idx] = {
                    ok: true,
                    backendNodeId: chunk[idx]!,
                    value: item.value,
                  };
                }
              }
              // Confirmed zero callback invocations in this chunk (every resolved node was already
              // disconnected): preserve the prior invocation state so later pre-call context loss
              // can still safely rebuild and retry from chunk 0.
              if (!chunkInvoked) callbackInvokedOrUncertain = prevInvoked;
            }
            results.push(...chunkResults);
          } finally {
            // Queue group release immediately without stalling past the caller's deadline;
            // `connection.drain()` waits for wire settlement (not release success).
            void group.release().catch(() => {});
          }
        }
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        return results;
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        const siblingDetached =
          !entry &&
          this.scope === 'target' &&
          !this.session.closed &&
          error instanceof SessionEndedError;
        if (!isWorldGone(error) && !siblingDetached) throw error;
        if (entry) this.markEntryLost(slot, entry);
        else if (isWorldGone(error)) slot.recovering = true;
        if (!retry || attempt > 0 || callbackInvokedOrUncertain) throw error;
      }
    }
  }

  /**
   * Evaluates a string expression or function in this isolated world and returns its value.
   * Never enables `Runtime`, `Page` or `DOM`, never falls back to the main world, forwards
   * `silent`, `disableBreaks`, `throwOnSideEffect`, `userGesture` and `executionTimeout`, and
   * rebuilds/retries at most once on context loss (unless `retryOnContextGone: false`).
   */
  async evaluate<T = unknown, A = unknown>(
    fn: string | ((arg: A) => T | Promise<T>),
    arg?: A,
    options: IsolatedEvaluateOptions = {},
  ): Promise<T> {
    if (options.executionTimeout !== undefined) {
      if (
        !Number.isFinite(options.executionTimeout) ||
        options.executionTimeout <= 0 ||
        options.executionTimeout > MAX_TIMEOUT
      )
        throw new RangeError(
          `executionTimeout must be a positive finite number up to ${MAX_TIMEOUT} ms`,
        );
    }
    const epoch = this.disposeEpoch;
    const disposeSignal = this.disposeController.signal;
    const step = budget(options, 'isolated world evaluation');
    const retry = options.retryOnContextGone ?? true;
    const needsEvaluate =
      options.executionTimeout !== undefined ||
      options.disableBreaks !== undefined ||
      (options.throwOnSideEffect !== undefined && typeof fn === 'string');
    const noEval = Boolean(options.throwOnSideEffect);
    // Serialize function arguments up front so invalid/circular values fail before any CDP work.
    const serializedArg =
      typeof fn === 'function' && (needsEvaluate || this.verification === 'guard')
        ? serializeEvaluateValue(arg)
        : undefined;
    const evalExtras = {
      ...(options.silent !== undefined ? { silent: options.silent } : {}),
      ...(options.disableBreaks !== undefined ? { disableBreaks: options.disableBreaks } : {}),
      ...(options.throwOnSideEffect !== undefined
        ? { throwOnSideEffect: options.throwOnSideEffect }
        : {}),
      ...(options.userGesture !== undefined ? { userGesture: options.userGesture } : {}),
      ...(options.executionTimeout !== undefined ? { timeout: options.executionTimeout } : {}),
    };
    const callFnExtras = {
      ...(options.silent !== undefined ? { silent: options.silent } : {}),
      ...(options.throwOnSideEffect !== undefined
        ? { throwOnSideEffect: options.throwOnSideEffect }
        : {}),
      ...(options.userGesture !== undefined ? { userGesture: options.userGesture } : {}),
    };

    for (let attempt = 0; ; attempt++) {
      const slot = this.activeSlot();
      let entry: WorldEntry | undefined;
      try {
        const acquired = await this.acquire(
          slot,
          step,
          false,
          epoch,
          disposeSignal,
          options.onEvent,
        );
        entry = acquired;
        if (this.disposeEpoch !== epoch) throw this.disposedError();

        if (acquired.kind === 'strict') {
          if (needsEvaluate) {
            const guard = await this.ensureStrictGuard(acquired, step, disposeSignal);
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            const guardedExpression =
              typeof fn === 'string'
                ? buildGuardedCodeExpression(fn, guard.token, guard.mismatch, noEval)
                : buildGuardedFunctionExpression(
                    fn.toString(),
                    serializedArg!,
                    guard.token,
                    guard.mismatch,
                  );
            const result = await this.session.sendWith(
              'Runtime.evaluate',
              withLateExceptionCleanup(step(), this.session, disposeSignal),
              {
                expression: guardedExpression,
                contextId: acquired.contextId,
                awaitPromise: true,
                returnByValue: true,
                ...evalExtras,
              },
            );
            if (this.disposeEpoch !== epoch) {
              releaseRemoteObjects(result, this.session);
              throw this.disposedError();
            }
            throwEvaluationException(result, this.session, guard.mismatch);
            return decodeRemoteValue(result.result) as T;
          }
          const result =
            typeof fn === 'string'
              ? await this.session.sendWith(
                  'Runtime.callFunctionOn',
                  withLateExceptionCleanup(step(), this.session, disposeSignal),
                  {
                    objectId: acquired.objectId,
                    functionDeclaration: 'function(code){return (0,eval)(code)}',
                    arguments: [{ value: fn }],
                    awaitPromise: true,
                    returnByValue: true,
                    ...callFnExtras,
                  },
                )
              : await this.session.sendWith(
                  'Runtime.callFunctionOn',
                  withLateExceptionCleanup(step(), this.session, disposeSignal),
                  {
                    objectId: acquired.objectId,
                    functionDeclaration: `function(arg){return (${fn.toString()})(arg)}`,
                    arguments: [encodeCallArgument(arg)],
                    awaitPromise: true,
                    returnByValue: true,
                    ...callFnExtras,
                  },
                );
          if (this.disposeEpoch !== epoch) {
            releaseRemoteObjects(result, this.session);
            throw this.disposedError();
          }
          throwEvaluationException(result, this.session);
          return decodeRemoteValue(result.result) as T;
        }

        if (acquired.kind === 'none') {
          if (typeof fn === 'string' || needsEvaluate) {
            const expression =
              typeof fn === 'string' ? fn : `(${fn.toString()})(${serializedArg!})`;
            const result = await this.session.sendWith(
              'Runtime.evaluate',
              withLateExceptionCleanup(step(), this.session, disposeSignal),
              {
                expression,
                contextId: acquired.contextId,
                awaitPromise: true,
                returnByValue: true,
                ...evalExtras,
              },
            );
            if (this.disposeEpoch !== epoch) {
              releaseRemoteObjects(result, this.session);
              throw this.disposedError();
            }
            throwEvaluationException(result, this.session);
            return decodeRemoteValue(result.result) as T;
          }
          const result = await this.session.sendWith(
            'Runtime.callFunctionOn',
            withLateExceptionCleanup(step(), this.session, disposeSignal),
            {
              executionContextId: acquired.contextId,
              functionDeclaration: `function(arg){return (${fn.toString()})(arg)}`,
              arguments: [encodeCallArgument(arg)],
              awaitPromise: true,
              returnByValue: true,
              ...callFnExtras,
            },
          );
          if (this.disposeEpoch !== epoch) {
            releaseRemoteObjects(result, this.session);
            throw this.disposedError();
          }
          throwEvaluationException(result, this.session);
          return decodeRemoteValue(result.result) as T;
        }

        const mismatch = `__nodriver_iso_mismatch_${randomUUID()}__`;
        const expression =
          typeof fn === 'string'
            ? buildGuardedCodeExpression(fn, acquired.token, mismatch, noEval)
            : buildGuardedFunctionExpression(
                fn.toString(),
                serializedArg!,
                acquired.token,
                mismatch,
              );
        const result = await this.session.sendWith(
          'Runtime.evaluate',
          withLateExceptionCleanup(step(), this.session, disposeSignal),
          {
            expression,
            contextId: acquired.contextId,
            awaitPromise: true,
            returnByValue: true,
            ...evalExtras,
          },
        );
        if (this.disposeEpoch !== epoch) {
          releaseRemoteObjects(result, this.session);
          throw this.disposedError();
        }
        throwEvaluationException(result, this.session, mismatch);
        return decodeRemoteValue(result.result) as T;
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        const siblingDetached =
          !entry &&
          this.scope === 'target' &&
          !this.session.closed &&
          error instanceof SessionEndedError;
        if (!isWorldGone(error) && !siblingDetached) throw error;
        if (entry) this.markEntryLost(slot, entry);
        else if (isWorldGone(error)) slot.recovering = true;
        if (!retry || attempt > 0) throw error;
      }
    }
  }
}

export function createIsolatedWorld(
  session: Session,
  options: IsolatedWorldOptions = {},
): IsolatedWorld {
  return new IsolatedWorld(session, options);
}

/**
 * Multi-frame isolated world pool on one `Session`, sharing a consistent `worldName` and caching
 * one `IsolatedWorld` wrapper per `frameId` (with `scope: 'target'` reusing the connection-level
 * world cache across ephemeral `TargetSession`s).
 */
export class IsolatedWorldPool {
  readonly session: Session;
  readonly worldName: string;
  readonly scope: IsolatedWorldScope;
  readonly verification: IsolatedWorldVerification;
  private readonly options: IsolatedWorldPoolOptions;
  private readonly worlds = new Map<string, IsolatedWorld>();
  private disposed = false;

  constructor(session: Session, options: IsolatedWorldPoolOptions = {}) {
    if (!session.id) throw new TypeError('IsolatedWorldPool requires a target session');
    const scope = options.scope ?? 'session';
    if (scope !== 'session' && scope !== 'target')
      throw new TypeError('IsolatedWorld scope must be "session" or "target"');
    const verification = options.verification ?? (scope === 'target' ? 'guard' : 'strict');
    if (verification !== 'strict' && verification !== 'guard' && verification !== 'none')
      throw new TypeError('IsolatedWorld verification must be "strict", "guard" or "none"');
    if (scope === 'target' && verification === 'strict')
      throw new TypeError(
        'IsolatedWorld verification "strict" requires scope "session" because RemoteObjectId handles are session-scoped',
      );
    if (session instanceof TargetSession) {
      if (options.targetId !== undefined && options.targetId !== session.targetId)
        throw new TypeError('IsolatedWorld targetId does not match TargetSession.targetId');
    } else if (scope === 'target' && !options.targetId) {
      throw new TypeError(
        'IsolatedWorld scope "target" requires a TargetSession or explicit targetId',
      );
    }
    if (options.worldName !== undefined && !options.worldName)
      throw new TypeError('IsolatedWorld worldName must be a non-empty string');
    this.session = session;
    this.scope = scope;
    this.verification = verification;
    this.worldName = options.worldName ?? randomUUID();
    this.options = { ...options, worldName: this.worldName, scope, verification };
  }

  /** Returns (creating if needed) the `IsolatedWorld` for `frameId`. */
  world(frameId: string): IsolatedWorld {
    if (!frameId) throw new TypeError('frameId must be a non-empty string');
    if (this.disposed)
      throw new StaleElementError('IsolatedWorldPool was disposed', { reason: 'disposed' });
    let world = this.worlds.get(frameId);
    if (!world) {
      world = new IsolatedWorld(this.session, { ...this.options, frameId });
      this.worlds.set(frameId, world);
    }
    return world;
  }

  /** Evaluates in a single frame managed by this pool. */
  evaluate<T = unknown, A = unknown>(
    frameId: string,
    fn: string | ((arg: A) => T | Promise<T>),
    arg?: A,
    options: IsolatedEvaluateOptions = {},
  ): Promise<T> {
    return this.world(frameId).evaluate<T, A>(fn, arg, options);
  }

  /**
   * Fans out an isolated-world evaluation across `frameIds` under one shared timeout/signal,
   * isolating per-frame detachments (`status: 'detached'`) and per-frame script errors
   * (`status: 'error'`) so one disappearing subframe never aborts sibling frames.
   */
  async evaluateAll<T = unknown, A = unknown>(
    frameIds: readonly string[],
    fn: string | ((arg: A) => T | Promise<T>),
    arg?: A,
    options: IsolatedEvaluateOptions & { concurrency?: number } = {},
  ): Promise<Array<FrameEvaluationOutcome<T>>> {
    if (!Array.isArray(frameIds)) throw new TypeError('frameIds must be an array');
    for (const frameId of frameIds) {
      if (!frameId) throw new TypeError('frameId must be a non-empty string');
    }
    const concurrency = options.concurrency ?? Infinity;
    if (concurrency !== Infinity) positiveInt(concurrency, 'concurrency');
    if (options.executionTimeout !== undefined) {
      if (
        !Number.isFinite(options.executionTimeout) ||
        options.executionTimeout <= 0 ||
        options.executionTimeout > MAX_TIMEOUT
      )
        throw new RangeError(
          `executionTimeout must be a positive finite number up to ${MAX_TIMEOUT} ms`,
        );
    }
    const step = budget(options, 'IsolatedWorldPool.evaluateAll');
    if (this.disposed)
      throw new StaleElementError('IsolatedWorldPool was disposed', { reason: 'disposed' });
    if (this.session.closed) throw this.session.closedError();
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (!frameIds.length) return [];

    const { concurrency: _unused, ...evalOptions } = options;
    const outcomes = new Array<FrameEvaluationOutcome<T>>(frameIds.length);
    const fatalController = new AbortController();
    let cursor = 0;
    let fatalError: unknown;
    let hasFatal = false;

    const recordFatal = (error: unknown) => {
      if (!hasFatal) {
        hasFatal = true;
        fatalError = error;
        fatalController.abort(error);
      }
    };

    const worker = async () => {
      while (!hasFatal) {
        const idx = cursor++;
        if (idx >= frameIds.length) return;
        const frameId = frameIds[idx]!;
        let remaining: WaitOptions;
        try {
          if (this.disposed)
            throw new StaleElementError('IsolatedWorldPool was disposed', { reason: 'disposed' });
          if (this.session.closed) throw this.session.closedError();
          remaining = step();
        } catch (error) {
          recordFatal(error);
          return;
        }
        try {
          const value = await this.world(frameId).evaluate<T, A>(fn, arg, {
            ...evalOptions,
            ...withSignal(remaining, fatalController.signal),
          });
          outcomes[idx] = { status: 'ok', frameId, value };
        } catch (error) {
          if (
            hasFatal ||
            this.disposed ||
            this.session.closed ||
            options.signal?.aborted ||
            error instanceof DisconnectedError ||
            error instanceof SessionEndedError ||
            error instanceof TimeoutError
          ) {
            recordFatal(error);
            return;
          }
          try {
            step();
          } catch (budgetError) {
            recordFatal(budgetError);
            return;
          }
          if (isFrameGone(error)) {
            const stale =
              error instanceof StaleElementError && error.reason === 'frame-detached'
                ? error
                : new StaleElementError('Frame is detached', {
                    cause: error,
                    reason: 'frame-detached',
                  });
            outcomes[idx] = { status: 'detached', frameId, error: stale };
          } else {
            outcomes[idx] = { status: 'error', frameId, error };
          }
        }
      }
    };

    const workers = Math.min(concurrency, frameIds.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
    if (hasFatal) throw fatalError;
    return outcomes;
  }

  /** Invalidates one frame's cached world or every frame in this pool. */
  invalidate(frameId?: string): void {
    if (frameId !== undefined) {
      this.worlds.get(frameId)?.invalidate();
      return;
    }
    for (const world of this.worlds.values()) world.invalidate();
  }

  /** Disposes every `IsolatedWorld` wrapper created by this pool. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const world of this.worlds.values()) world.dispose();
    this.worlds.clear();
  }
}

export function createIsolatedWorldPool(
  session: Session,
  options: IsolatedWorldPoolOptions = {},
): IsolatedWorldPool {
  return new IsolatedWorldPool(session, options);
}

/**
 * Fans out an isolated-world evaluation across multiple `frameIds` on `session` without enabling
 * any CDP domain. Tolerates disappearing subframes (`status: 'detached'`) and per-frame script
 * errors (`status: 'error'`), and shares connection-level target caches when `scope: 'target'`.
 */
export async function evaluateAcrossFrames<T = unknown, A = unknown>(
  session: Session,
  frameIds: readonly string[],
  fn: string | ((arg: A) => T | Promise<T>),
  arg?: A,
  options: EvaluateAcrossFramesOptions = {},
): Promise<Array<FrameEvaluationOutcome<T>>> {
  let worldName = options.worldName;
  if (worldName === undefined && (options.scope ?? 'session') === 'target') {
    worldName = connectionDefaultWorldNames.get(session.connection);
    if (!worldName) connectionDefaultWorldNames.set(session.connection, (worldName = randomUUID()));
  }
  const pool = new IsolatedWorldPool(session, {
    worldName,
    grantUniversalAccess: options.grantUniversalAccess,
    scope: options.scope,
    targetId: options.targetId,
    verification: options.verification,
    onEvent: options.onEvent,
  });
  try {
    return await pool.evaluateAll<T, A>(frameIds, fn, arg, options);
  } finally {
    pool.dispose();
  }
}

const sessionWorlds = new WeakMap<Session, Map<string, IsolatedWorld>>();
const sessionDefaultWorldNames = new WeakMap<Session, string>();

function cachedSessionWorld(session: Session, options: IsolatedWorldOptions): IsolatedWorld {
  if (!session.id) throw new TypeError('evaluateIsolated requires a target session');
  if (
    session instanceof TargetSession &&
    options.targetId !== undefined &&
    options.targetId !== session.targetId
  )
    throw new TypeError('IsolatedWorld targetId does not match TargetSession.targetId');
  const frameId =
    options.frameId ?? (session instanceof TargetSession ? session.targetId : options.targetId);
  if (!frameId) throw new TypeError('evaluateIsolated requires frameId for a plain Session');
  if (options.worldName !== undefined && !options.worldName)
    throw new TypeError('IsolatedWorld worldName must be a non-empty string');
  let worldName = options.worldName;
  if (worldName === undefined) {
    worldName = sessionDefaultWorldNames.get(session);
    if (!worldName) sessionDefaultWorldNames.set(session, (worldName = randomUUID()));
  }
  const grantUniversalAccess = options.grantUniversalAccess ?? false;
  const verification = options.verification ?? 'strict';
  if (verification !== 'strict' && verification !== 'guard' && verification !== 'none')
    throw new TypeError('IsolatedWorld verification must be "strict", "guard" or "none"');
  const key = `${frameId}\0${worldName}\0${grantUniversalAccess ? 1 : 0}\0${verification}`;
  let worlds = sessionWorlds.get(session);
  if (!worlds) {
    worlds = new Map();
    sessionWorlds.set(session, worlds);
    if (!session.closed) {
      session.disconnected.on(() => {
        for (const world of worlds!.values()) world.dispose();
        sessionWorlds.delete(session);
      });
    }
  }
  let world = worlds.get(key);
  if (!world) {
    world = new IsolatedWorld(session, {
      frameId,
      worldName,
      grantUniversalAccess,
      scope: 'session',
      verification,
    });
    worlds.set(key, world);
  }
  return world;
}

/**
 * Evaluates a string expression or function in a cached isolated world without sending
 * `Runtime.enable`, `Page.enable` or `DOM.enable`, never falling back to the main world.
 * Pass `scope: 'target'` to reuse the cached world across ephemeral `TargetSession`s on the same
 * `Connection` (defaults to `verification: 'guard'`; pass `verification: 'none'` for unwrapped
 * expressions with zero global properties).
 */
export function evaluateIsolated<T = unknown, A = unknown>(
  session: Session,
  fn: string | ((arg: A) => T | Promise<T>),
  arg?: A,
  options: EvaluateIsolatedOptions = {},
): Promise<T> {
  const scope = options.scope ?? 'session';
  if (scope !== 'session' && scope !== 'target')
    throw new TypeError('IsolatedWorld scope must be "session" or "target"');
  if (scope === 'target') {
    let worldName = options.worldName;
    if (worldName === undefined) {
      worldName = connectionDefaultWorldNames.get(session.connection);
      if (!worldName)
        connectionDefaultWorldNames.set(session.connection, (worldName = randomUUID()));
    }
    const world = new IsolatedWorld(session, {
      frameId: options.frameId,
      worldName,
      grantUniversalAccess: options.grantUniversalAccess,
      scope: 'target',
      targetId: options.targetId,
      verification: options.verification,
    });
    return world.evaluate<T, A>(fn, arg, options);
  }
  return cachedSessionWorld(session, options).evaluate<T, A>(fn, arg, options);
}
