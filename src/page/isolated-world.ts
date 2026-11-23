import { randomUUID } from 'node:crypto';
import type { Protocol } from 'devtools-protocol';
import { TargetSession, type Session } from '../protocol/connection.ts';
import { DisconnectedError, EvaluationError, ProtocolError, StaleElementError } from '../errors.ts';
import { abortReason, bounded, budget, type WaitOptions } from '../utils.ts';
import { isContextGone, parseRemoteObjectId } from './execution-context.ts';

export interface IsolatedWorldOptions {
  /**
   * Frame to create the isolated world in. Defaults to `session.targetId` for a `TargetSession`.
   * Required for a plain `Session`.
   */
  frameId?: string;
  /**
   * Name passed to `Page.createIsolatedWorld`. Defaults to a random UUID (per `IsolatedWorld`
   * instance, or per session for `evaluateIsolated()`).
   */
  worldName?: string;
  /** Passed to `Page.createIsolatedWorld({ grantUniveralAccess })`. Defaults to false. */
  grantUniversalAccess?: boolean;
}

export interface IsolatedRunOptions extends WaitOptions {
  /**
   * Rebuild the isolated world and retry once if Chrome reports `isContextGone(error)` or a
   * context-binding mismatch. Defaults to true. Set to false when the callback has side effects
   * that must never replay.
   */
  retryOnContextGone?: boolean;
}

export interface IsolatedEvaluateOptions extends IsolatedRunOptions {
  /** CDP execution limit in milliseconds, for string expressions only. Does not cancel timers/tasks. */
  executionTimeout?: number;
}

export interface EvaluateIsolatedOptions extends IsolatedWorldOptions, IsolatedEvaluateOptions {}

interface WorldGuard {
  readonly key: string;
  readonly token: string;
  readonly mismatch: string;
}

interface WorldEntry {
  readonly contextId: number;
  readonly objectId: string;
  readonly objectGroup: string;
  guard?: WorldGuard;
  guardPending?: Promise<WorldGuard>;
}

const GUARD_KEY = '__nodriver_isolated_world_guard__';

/** Internal signal that a numeric executionContextId resolved into the wrong world or frame. */
class WorldMismatchError extends StaleElementError {
  override name = 'WorldMismatchError';
}

function callArgument(value: unknown): Protocol.Runtime.CallArgument {
  if (typeof value === 'bigint') return { unserializableValue: `${value}n` };
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    return { unserializableValue: Object.is(value, -0) ? '-0' : String(value) };
  return { value };
}

function remoteValue(object: Protocol.Runtime.RemoteObject): unknown {
  const value = object.unserializableValue;
  if (value) {
    if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
    if (value === 'NaN') return NaN;
    if (value === 'Infinity') return Infinity;
    if (value === '-Infinity') return -Infinity;
    if (value === '-0') return -0;
  }
  return object.value;
}

function throwEvaluationException(
  result: { exceptionDetails?: Protocol.Runtime.ExceptionDetails },
  session: Session,
  mismatchSentinel?: string,
): void {
  const details = result.exceptionDetails;
  if (!details) return;
  const exception = details.exception;
  if (exception?.objectId && !session.closed)
    void session.send('Runtime.releaseObject', { objectId: exception.objectId }).catch(() => {});
  const description =
    exception?.description ??
    (exception && 'value' in exception
      ? `${details.text} ${String(exception.value)}`
      : details.text);
  if (mismatchSentinel && description.includes(mismatchSentinel))
    throw new WorldMismatchError('Isolated world execution context no longer matches');
  throw new EvaluationError(description);
}

function withSignal(wait: WaitOptions, signal: AbortSignal): WaitOptions {
  return {
    ...wait,
    signal: wait.signal ? AbortSignal.any([wait.signal, signal]) : signal,
  };
}

/** Whether Chrome rejected our own isolated-world `globalThis` handle or context as gone/mismatched. */
function isWorldGone(error: unknown): boolean {
  return (
    error instanceof WorldMismatchError ||
    isContextGone(error) ||
    (error instanceof ProtocolError &&
      error.code === -32000 &&
      /Could not find object with given id/.test(error.message))
  );
}

/**
 * Lightweight isolated-world helper for raw sessions (`attach: 'none'`).
 * Never calls `Runtime.enable`, `Page.enable` or `DOM.enable`, verifies that the bound V8
 * `RemoteObjectId` handle for `globalThis` is genuinely an isolated world (distinct from the
 * frame's main world), uses handle-bound execution (and an isolated-world guard token for
 * `executionTimeout`) so a numeric `executionContextId` reused across process boundaries can never
 * run user code in the wrong world, rebuilds and retries at most once on context loss, and never
 * falls back to the page's main world.
 */
export class IsolatedWorld {
  readonly session: Session;
  readonly frameId: string;
  readonly worldName: string;
  readonly grantUniversalAccess: boolean;
  private generation = 0;
  private disposeEpoch = 0;
  private disposeController = new AbortController();
  private cached?: WorldEntry;
  private pending?: Promise<WorldEntry>;
  private offDisconnect?: () => void;

  constructor(session: Session, options: IsolatedWorldOptions = {}) {
    if (!session.id) throw new TypeError('IsolatedWorld requires a target session');
    const frameId =
      options.frameId ?? (session instanceof TargetSession ? session.targetId : undefined);
    if (!frameId) throw new TypeError('IsolatedWorld requires frameId for a plain Session');
    if (options.worldName !== undefined && !options.worldName)
      throw new TypeError('IsolatedWorld worldName must be a non-empty string');
    this.session = session;
    this.frameId = frameId;
    this.worldName = options.worldName ?? randomUUID();
    this.grantUniversalAccess = options.grantUniversalAccess ?? false;
  }

  private releaseGroup(objectGroup: string): void {
    if (this.session.closed) return;
    void this.session
      .sendWith('Runtime.releaseObjectGroup', { timeout: 1000 }, { objectGroup })
      .catch(() => {});
  }

  private disposedError(): Error {
    if (this.session.closed)
      return this.session.closeReason ?? new DisconnectedError('Session closed');
    return new StaleElementError('IsolatedWorld was disposed');
  }

  private createEntry(epoch: number): Promise<WorldEntry> {
    if (this.disposeEpoch !== epoch) return Promise.reject(this.disposedError());
    if (!this.pending) {
      this.offDisconnect ??= this.session.disconnected.on(() => this.dispose());
      const generation = this.generation;
      const objectGroup = `nodriver-isolated-${randomUUID()}`;
      let groupAllocated = false;
      let groupReleased = false;
      const releaseOnce = () => {
        if (!groupAllocated || groupReleased) return;
        groupReleased = true;
        this.releaseGroup(objectGroup);
      };
      let settled = false;
      let task!: Promise<WorldEntry>;
      task = (async (): Promise<WorldEntry> => {
        try {
          const createParams = {
            frameId: this.frameId,
            worldName: this.worldName,
            ...(this.grantUniversalAccess ? { grantUniveralAccess: true } : {}),
          };
          const { executionContextId } = await this.session.send(
            'Page.createIsolatedWorld',
            createParams,
          );
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          groupAllocated = true;
          const { result: global } = await this.session.send('Runtime.evaluate', {
            expression: 'globalThis',
            contextId: executionContextId,
            objectGroup,
            generatePreview: false,
          });
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          if (!global.objectId)
            throw new EvaluationError('Isolated world global object is unavailable');
          const isolated = parseRemoteObjectId(global.objectId);
          if (isolated.context !== executionContextId)
            throw new WorldMismatchError('Isolated world handle context does not match creation');
          // Verify that global.objectId is genuinely the requested named isolated world of this
          // frame—NOT a main world or a different isolated world that happened to reuse
          // `executionContextId` across a process swap.
          const verifyGroup = `nodriver-isolated-verify-${randomUUID()}`;
          try {
            const doc = await this.session.send('Runtime.callFunctionOn', {
              objectId: global.objectId,
              functionDeclaration: 'function(){return this.document}',
              objectGroup: verifyGroup,
              generatePreview: false,
            });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (!doc.result.objectId)
              throw new WorldMismatchError('Isolated world document is unavailable');
            const { node } = await this.session.send('DOM.describeNode', {
              objectId: doc.result.objectId,
            });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (node.frameId && node.frameId !== this.frameId)
              throw new WorldMismatchError('Isolated world resolved to a different frame');
            // Omitting executionContextId resolves into the owning frame's main world without
            // enabling the DOM domain.
            const { object: mainDoc } = await this.session.send('DOM.resolveNode', {
              backendNodeId: node.backendNodeId,
              objectGroup: verifyGroup,
            });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (!mainDoc.objectId)
              throw new WorldMismatchError(
                'Main-world document is unavailable during verification',
              );
            const main = parseRemoteObjectId(mainDoc.objectId);
            if (main.isolate !== isolated.isolate || main.context === isolated.context)
              throw new WorldMismatchError(
                'Isolated world handle collided with the main-world execution context',
              );
            // Re-query the non-empty worldName on this frame (idempotent in Chromium) and prove
            // the document wrapper resolved in that context is strictly identical to our handle's
            // document wrapper, ruling out collisions with another named isolated world.
            const { executionContextId: confirmedId } = await this.session.send(
              'Page.createIsolatedWorld',
              createParams,
            );
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (confirmedId !== executionContextId)
              throw new WorldMismatchError(
                'Isolated world handle does not match the requested worldName',
              );
            const { object: confirmedDoc } = await this.session.send('DOM.resolveNode', {
              backendNodeId: node.backendNodeId,
              executionContextId: confirmedId,
              objectGroup: verifyGroup,
            });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (!confirmedDoc.objectId)
              throw new WorldMismatchError('Isolated world document confirmation is unavailable');
            const confirmed = parseRemoteObjectId(confirmedDoc.objectId);
            if (confirmed.isolate !== isolated.isolate || confirmed.context !== isolated.context)
              throw new WorldMismatchError(
                'Isolated world confirmation resolved to a different context',
              );
            const sameWorld = await this.session.send('Runtime.callFunctionOn', {
              objectId: doc.result.objectId,
              functionDeclaration: 'function(other){return this === other}',
              arguments: [{ objectId: confirmedDoc.objectId }],
              returnByValue: true,
            });
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (sameWorld.exceptionDetails || sameWorld.result.value !== true)
              throw new WorldMismatchError('Isolated world handle does not match the named world');
          } catch (error) {
            if (this.disposeEpoch !== epoch) throw this.disposedError();
            if (
              error instanceof ProtocolError &&
              error.code === -32000 &&
              /No node with given id found|same JavaScript world/.test(error.message)
            )
              throw new WorldMismatchError(
                'Isolated world document or world changed during verification',
              );
            throw error;
          } finally {
            this.releaseGroup(verifyGroup);
          }
          const entry: WorldEntry = {
            contextId: executionContextId,
            objectId: global.objectId,
            objectGroup,
          };
          settled = true;
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          if (this.pending === task && this.generation === generation) {
            this.cached = entry;
            this.pending = undefined;
            return entry;
          }
          throw new WorldMismatchError('Isolated world was invalidated during creation');
        } catch (error) {
          settled = true;
          if (this.pending === task) this.pending = undefined;
          releaseOnce();
          throw error;
        }
      })();
      if (!settled) this.pending = task;
      void task.catch(() => {});
      return task;
    }
    return this.pending;
  }

  private async verifyEntry(entry: WorldEntry, options: WaitOptions): Promise<boolean> {
    try {
      await this.session.sendWith('Runtime.callFunctionOn', options, {
        objectId: entry.objectId,
        functionDeclaration: 'function(){return 1}',
        returnByValue: true,
      });
      return true;
    } catch (error) {
      if (!isWorldGone(error)) throw error;
      this.invalidateEntry(entry);
      return false;
    }
  }

  private async ensureGuard(
    entry: WorldEntry,
    step: () => WaitOptions,
    disposeSignal: AbortSignal,
  ): Promise<WorldGuard> {
    if (entry.guard) return entry.guard;
    const wait = withSignal(step(), disposeSignal);
    if (!entry.guardPending) {
      const proposedToken = `ndg:${randomUUID()}`;
      const mismatch = `__nodriver_iso_mismatch_${randomUUID()}__`;
      let settled = false;
      let task!: Promise<WorldGuard>;
      task = (async () => {
        try {
          const res = await this.session.send('Runtime.callFunctionOn', {
            objectId: entry.objectId,
            functionDeclaration:
              'function(k,t){var d=Object.getOwnPropertyDescriptor(this,k);if(d&&typeof d.value==="string"&&d.value.startsWith("ndg:")&&!d.configurable&&!d.writable)return d.value;Object.defineProperty(this,k,{value:t,enumerable:false,configurable:false,writable:false});return t}',
            arguments: [{ value: GUARD_KEY }, { value: proposedToken }],
            returnByValue: true,
          });
          throwEvaluationException(res, this.session);
          const token = res.result.value;
          if (typeof token !== 'string' || !token.startsWith('ndg:'))
            throw new EvaluationError('Isolated world guard token is unavailable');
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
      return bounded(task, wait, 'isolated world guard');
    }
    return bounded(entry.guardPending, wait, 'isolated world guard');
  }

  private async acquire(
    step: () => WaitOptions,
    verify: boolean,
    epoch: number,
    disposeSignal: AbortSignal,
  ): Promise<WorldEntry> {
    if (this.session.closed)
      throw this.session.closeReason ?? new DisconnectedError('Session closed');
    if (this.disposeEpoch !== epoch) throw this.disposedError();
    // Check deadline and AbortSignal BEFORE starting or joining any CDP work.
    const wait = step();
    const cached = this.cached;
    if (cached) {
      if (!verify) return cached;
      if (await this.verifyEntry(cached, withSignal(wait, disposeSignal))) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        return cached;
      }
    }
    if (this.disposeEpoch !== epoch) throw this.disposedError();
    const createWait = withSignal(step(), disposeSignal);
    const entry = await bounded(this.createEntry(epoch), createWait, 'isolated world creation');
    if (this.disposeEpoch !== epoch) throw this.disposedError();
    return entry;
  }

  private invalidateEntry(stale: WorldEntry): void {
    if (this.cached !== stale) return;
    this.generation++;
    this.cached = undefined;
    this.pending = undefined;
    this.releaseGroup(stale.objectGroup);
  }

  /**
   * Resolves (or verifies and reuses) this isolated world's numeric execution context ID without
   * enabling `Runtime`, `Page` or `DOM`.
   *
   * Note on lifetime: a numeric `executionContextId` is a point-in-time snapshot valid only while
   * the current document and renderer process stay alive; Chrome may reuse numeric IDs across
   * process boundaries after navigation. A cached entry is verified through its `globalThis` handle
   * before returning, and context loss during creation retries once within `options`. Prefer
   * `evaluate()` when you want handle-bound execution without exposing a numeric ID.
   */
  async context(options: WaitOptions = {}): Promise<number> {
    if (this.session.closed)
      throw this.session.closeReason ?? new DisconnectedError('Session closed');
    if (options.signal?.aborted) throw abortReason(options.signal);
    const epoch = this.disposeEpoch;
    const disposeSignal = this.disposeController.signal;
    const step = budget(options, 'isolated world creation');
    for (let attempt = 0; ; attempt++) {
      let entry: WorldEntry | undefined;
      try {
        entry = await this.acquire(step, true, epoch, disposeSignal);
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        return entry.contextId;
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        if (!isWorldGone(error)) throw error;
        if (entry) this.invalidateEntry(entry);
        if (attempt > 0) throw error;
      }
    }
  }

  /**
   * Drops the cached execution context. When `staleContextId` is given, only drops it if the cache
   * still holds that ID (so concurrent callers do not clobber a freshly rebuilt world).
   */
  invalidate(staleContextId?: number): void {
    if (staleContextId !== undefined) {
      if (this.cached !== undefined && this.cached.contextId !== staleContextId) return;
      if (this.cached === undefined && this.pending) return;
    }
    const previous = this.cached;
    this.generation++;
    this.cached = undefined;
    this.pending = undefined;
    if (previous) this.releaseGroup(previous.objectGroup);
  }

  /** Clears cached state, releases its remote object handle and removes the disconnect listener. */
  dispose(): void {
    const controller = this.disposeController;
    this.disposeEpoch++;
    this.disposeController = new AbortController();
    this.invalidate();
    this.offDisconnect?.();
    this.offDisconnect = undefined;
    controller.abort(this.disposedError());
  }

  /**
   * Runs `task` with a verified isolated-world execution context ID and a shared deadline stepper.
   * The numeric `contextId` passed to `task` is verified right before entry and remains valid only
   * while that document/renderer lives; a cross-process navigation during `task` may reuse numeric
   * IDs. Both world creation and awaiting `task` are bounded by `options.timeout` and
   * `options.signal` (arbitrary async work already started inside `task` may continue running
   * after timeout/cancellation). When context loss occurs during world creation or `task`
   * (`isContextGone(error)`), clears the stale world and rebuilds/retries at most once (unless
   * `retryOnContextGone: false`). Never falls back to the main world.
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
      let entry: WorldEntry | undefined;
      try {
        entry = await this.acquire(step, true, epoch, disposeSignal);
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        // Verify deadline and AbortSignal before entering task, then recompute remaining budget
        // after task's synchronous prologue returns so synchronous CPU time counts toward timeout.
        step();
        const running = new Promise<T>((resolve, reject) => {
          try {
            resolve(task(entry!.contextId, step));
          } catch (error) {
            reject(error);
          }
        });
        void running.catch(() => {});
        return await bounded(running, step(), 'isolated world operation');
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        const gone = entry
          ? isContextGone(error) || error instanceof WorldMismatchError
          : isWorldGone(error);
        if (!gone) throw error;
        if (entry) this.invalidateEntry(entry);
        if (!retry || attempt > 0) throw error;
      }
    }
  }

  /**
   * Evaluates a string expression or function in this isolated world and returns its JSON value.
   * Functions and expressions without `executionTimeout` run directly through `Runtime.callFunctionOn`
   * on the verified `globalThis` remote object handle (1 roundtrip on warm cache, immune to numeric
   * `executionContextId` reuse across processes). String expressions with `executionTimeout` check
   * a per-entry non-enumerable guard token inside `Runtime.evaluate` before running user code, so
   * even a cross-process navigation right before `Runtime.evaluate` cannot execute user code in the
   * wrong world. Never enables `Runtime`, `Page` or `DOM`, never falls back to the main world, and
   * rebuilds/retries at most once across world creation and evaluation on context loss (unless
   * `retryOnContextGone: false`).
   */
  async evaluate<T = unknown, A = unknown>(
    fn: string | ((arg: A) => T | Promise<T>),
    arg?: A,
    options: IsolatedEvaluateOptions = {},
  ): Promise<T> {
    if (options.executionTimeout !== undefined) {
      if (typeof fn !== 'string')
        throw new TypeError('executionTimeout is supported only for string expressions');
      if (!Number.isFinite(options.executionTimeout) || options.executionTimeout <= 0)
        throw new RangeError('executionTimeout must be a positive finite number');
    }
    const epoch = this.disposeEpoch;
    const disposeSignal = this.disposeController.signal;
    const step = budget(options, 'isolated world evaluation');
    const retry = options.retryOnContextGone ?? true;
    const useEvaluateTimeout = typeof fn === 'string' && options.executionTimeout !== undefined;
    for (let attempt = 0; ; attempt++) {
      let entry: WorldEntry | undefined;
      try {
        entry = await this.acquire(step, false, epoch, disposeSignal);
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        if (useEvaluateTimeout) {
          const guard = await this.ensureGuard(entry, step, disposeSignal);
          if (this.disposeEpoch !== epoch) throw this.disposedError();
          const guardedExpression = `(()=>{try{return Object.getOwnPropertyDescriptor(globalThis,${JSON.stringify(guard.key)})?.value===${JSON.stringify(guard.token)}}catch{return false}})()?(0,eval)(${JSON.stringify(fn)}):(()=>{throw ${JSON.stringify(guard.mismatch)}})()`;
          const result = await this.session.sendWith('Runtime.evaluate', step(), {
            expression: guardedExpression,
            contextId: entry.contextId,
            awaitPromise: true,
            returnByValue: true,
            timeout: options.executionTimeout,
          });
          throwEvaluationException(result, this.session, guard.mismatch);
          return remoteValue(result.result) as T;
        }
        const result =
          typeof fn === 'string'
            ? await this.session.sendWith('Runtime.callFunctionOn', step(), {
                objectId: entry.objectId,
                functionDeclaration: 'function(code){return (0,eval)(code)}',
                arguments: [{ value: fn }],
                awaitPromise: true,
                returnByValue: true,
              })
            : await this.session.sendWith('Runtime.callFunctionOn', step(), {
                objectId: entry.objectId,
                functionDeclaration: `function(arg){return (${fn.toString()})(arg)}`,
                arguments: [callArgument(arg)],
                awaitPromise: true,
                returnByValue: true,
              });
        throwEvaluationException(result, this.session);
        return remoteValue(result.result) as T;
      } catch (error) {
        if (this.disposeEpoch !== epoch) throw this.disposedError();
        if (!isWorldGone(error)) throw error;
        if (entry) this.invalidateEntry(entry);
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

const sessionWorlds = new WeakMap<Session, Map<string, IsolatedWorld>>();
const defaultWorldNames = new WeakMap<Session, string>();

function cachedWorld(session: Session, options: IsolatedWorldOptions): IsolatedWorld {
  if (!session.id) throw new TypeError('evaluateIsolated requires a target session');
  const frameId =
    options.frameId ?? (session instanceof TargetSession ? session.targetId : undefined);
  if (!frameId) throw new TypeError('evaluateIsolated requires frameId for a plain Session');
  if (options.worldName !== undefined && !options.worldName)
    throw new TypeError('IsolatedWorld worldName must be a non-empty string');
  let worldName = options.worldName;
  if (worldName === undefined) {
    worldName = defaultWorldNames.get(session);
    if (!worldName) defaultWorldNames.set(session, (worldName = randomUUID()));
  }
  const grantUniversalAccess = options.grantUniversalAccess ?? false;
  const key = `${frameId}\0${worldName}\0${grantUniversalAccess ? 1 : 0}`;
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
    world = new IsolatedWorld(session, { frameId, worldName, grantUniversalAccess });
    worlds.set(key, world);
  }
  return world;
}

/**
 * Evaluates a string expression or function in a cached isolated world for `(session, frameId, worldName)`
 * without sending `Runtime.enable`, `Page.enable` or `DOM.enable`. Verified via its `globalThis`
 * handle so cross-process numeric `executionContextId` reuse cannot target the wrong world,
 * rebuilds and retries at most once on context loss (unless `retryOnContextGone: false`), and
 * never falls back to the main world.
 */
export function evaluateIsolated<T = unknown, A = unknown>(
  session: Session,
  fn: string | ((arg: A) => T | Promise<T>),
  arg?: A,
  options: EvaluateIsolatedOptions = {},
): Promise<T> {
  return cachedWorld(session, options).evaluate<T, A>(fn, arg, options);
}
