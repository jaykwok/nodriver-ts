import type { Protocol } from 'devtools-protocol';
import { randomUUID } from 'node:crypto';
import type { Session, CdpEvent } from '../protocol/connection.js';
import { EvaluationError, StaleElementError, DisconnectedError } from '../errors.js';
import { EventHub, poll, type WaitOptions } from '../utils.js';
import { query, type Selector, type QueryOptions } from '../dom/query.js';
import type { Element } from '../dom/element.js';
import type { Tab } from './tab.js';
import { isContextGone, resolveMainContext } from './execution-context.js';
import {
  inspectEnvironment,
  type InspectEnvironmentOptions,
  type EnvironmentReport,
} from './environment.js';
export type World = 'main' | 'isolated';
export type EvaluationInput<A> = A extends JSHandle<infer Value> ? Value : A;
export interface EvaluateOptions extends WaitOptions {
  world?: World;
  /** CDP execution limit in milliseconds, for string expressions only. Does not cancel timers/tasks. */
  executionTimeout?: number;
}
export function argument(value: unknown): Protocol.Runtime.CallArgument {
  if (value instanceof JSHandle) {
    value.assertValid();
    return value.object.objectId
      ? { objectId: value.object.objectId }
      : argument(valueOf(value.object));
  }
  if (typeof value === 'bigint') return { unserializableValue: `${value}n` };
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    return { unserializableValue: Object.is(value, -0) ? '-0' : String(value) };
  return { value };
}
export function valueOf(object: Protocol.Runtime.RemoteObject): unknown {
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
export function checkException(result: {
  exceptionDetails?: Protocol.Runtime.ExceptionDetails;
}): void {
  if (result.exceptionDetails)
    throw new EvaluationError(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    );
}
export class JSHandle<T = unknown> {
  private disposed = false;
  readonly generation: number;
  readonly session: Session;
  constructor(
    readonly frame: Frame,
    readonly object: Protocol.Runtime.RemoteObject,
  ) {
    this.generation = frame.generation;
    this.session = frame.session;
  }
  assertValid(): void {
    if (
      this.disposed ||
      this.session.closed ||
      this.frame.detached ||
      this.generation !== this.frame.generation ||
      this.session !== this.frame.session
    )
      throw new StaleElementError('JavaScript handle belongs to an expired document');
  }
  async jsonValue(): Promise<T> {
    this.assertValid();
    if (!this.object.objectId) return valueOf(this.object) as T;
    const result = await this.session.send('Runtime.callFunctionOn', {
      objectId: this.object.objectId,
      functionDeclaration: 'function(){return this}',
      returnByValue: true,
      awaitPromise: true,
    });
    checkException(result);
    this.assertValid();
    return valueOf(result.result) as T;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.object.objectId && !this.session.closed)
      await this.session
        .send('Runtime.releaseObject', { objectId: this.object.objectId })
        .catch(() => {});
  }
  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }
}
export class Frame {
  generation = 0;
  detached = false;
  url = '';
  name = '';
  loaderId = '';
  parentId?: string;
  private main?: { generation: number; promise: Promise<number> };
  private isolated?: { generation: number; promise: Promise<number> };
  constructor(
    readonly manager: FrameManager,
    readonly id: string,
    public session: Session,
  ) {}
  get tab(): Tab {
    return this.manager.tab;
  }
  inspectEnvironment(options: InspectEnvironmentOptions = {}): Promise<EnvironmentReport> {
    return inspectEnvironment(this, options);
  }
  get parent(): Frame | undefined {
    return this.parentId ? this.manager.frames.get(this.parentId) : undefined;
  }
  get children(): Frame[] {
    return [...this.manager.frames.values()].filter((f) => f.parentId === this.id && !f.detached);
  }
  invalidate(): void {
    this.generation++;
    this.main = undefined;
    this.isolated = undefined;
  }
  async context(world: World, options: WaitOptions = {}): Promise<number> {
    if (this.detached || this.session.closed) throw new DisconnectedError('Frame is detached');
    if (world === 'main') {
      if (!this.main || this.main.generation !== this.generation) {
        const generation = this.generation;
        const session = this.session;
        const promise = this.context('isolated', options)
          .then((id) => {
            this.assertDocument(generation, session);
            return resolveMainContext(session, id, options);
          })
          .then((id) => {
            this.assertDocument(generation, session);
            return id;
          });
        this.main = { generation, promise };
        void promise.catch((error: unknown) => {
          if (this.main?.promise === promise) {
            this.main = undefined;
            if (isContextGone(error)) this.invalidate();
          }
        });
      }
      return this.main.promise;
    }
    if (!this.isolated || this.isolated.generation !== this.generation) {
      const generation = this.generation;
      const session = this.session;
      const promise = session
        .sendWith('Page.createIsolatedWorld', options, {
          frameId: this.id,
          worldName: this.manager.worldName,
        })
        .then((r) => {
          this.assertDocument(generation, session);
          return r.executionContextId;
        });
      this.isolated = { generation, promise };
      void promise.catch(() => {
        if (this.isolated?.promise === promise) this.isolated = undefined;
      });
    }
    return this.isolated.promise;
  }
  private assertDocument(generation: number, session: Session): void {
    if (
      this.detached ||
      session.closed ||
      generation !== this.generation ||
      session !== this.session
    )
      throw new StaleElementError('Frame changed while resolving execution context');
  }
  private async execute<T, A>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg: A | undefined,
    options: EvaluateOptions,
    handle: boolean,
  ): Promise<Protocol.Runtime.RemoteObject> {
    if (options.executionTimeout !== undefined) {
      if (typeof fn !== 'string')
        throw new TypeError('executionTimeout is supported only for string expressions');
      if (!Number.isFinite(options.executionTimeout) || options.executionTimeout <= 0)
        throw new RangeError('executionTimeout must be a positive finite number');
    }
    const generation = this.generation;
    const session = this.session;
    const contextId = await this.context(options.world ?? 'main', options);
    this.assertDocument(generation, session);
    if (arg instanceof JSHandle && (arg.session !== session || arg.frame !== this))
      throw new TypeError('Handle arguments must belong to this frame');
    let result: Protocol.Runtime.EvaluateResponse;
    try {
      result =
        typeof fn === 'string'
          ? await session.sendWith('Runtime.evaluate', options, {
              expression: fn,
              contextId,
              awaitPromise: true,
              returnByValue: !handle,
              timeout: options.executionTimeout,
            })
          : await session.sendWith('Runtime.callFunctionOn', options, {
              functionDeclaration: `function(arg){return (${fn.toString()})(arg)}`,
              executionContextId: contextId,
              arguments: [argument(arg)],
              awaitPromise: true,
              returnByValue: !handle,
            });
    } catch (error) {
      // Invalidate for the NEXT call; user code may already have had side effects.
      if (generation === this.generation && session === this.session && isContextGone(error))
        this.invalidate();
      throw error;
    }
    checkException(result);
    if (
      this.detached ||
      session.closed ||
      generation !== this.generation ||
      session !== this.session
    ) {
      if (result.result.objectId)
        await session
          .send('Runtime.releaseObject', { objectId: result.result.objectId })
          .catch(() => {});
      throw new StaleElementError('Frame navigated during evaluation; script was not replayed');
    }
    return result.result;
  }
  async evaluate<T = unknown, A = unknown>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg?: A,
    options: EvaluateOptions = {},
  ): Promise<T> {
    return valueOf(await this.execute(fn, arg, options, false)) as T;
  }
  async evaluateHandle<T = unknown, A = unknown>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg?: A,
    options: EvaluateOptions = {},
  ): Promise<JSHandle<T>> {
    return new JSHandle(this, await this.execute(fn, arg, options, true));
  }
  async queryAll(selector: Selector, options: QueryOptions = {}): Promise<Element[]> {
    return query(this, selector, options);
  }
  async query(selector: Selector, options: QueryOptions = {}): Promise<Element | undefined> {
    return (await this.queryAll(selector, { ...options, limit: 1 }))[0];
  }
  async waitForSelector(
    selector: Selector,
    options: QueryOptions & WaitOptions = {},
  ): Promise<Element> {
    return poll(
      async () => {
        try {
          return await this.query(selector, options);
        } catch (e) {
          if (e instanceof StaleElementError && !this.detached) return undefined;
          throw e;
        }
      },
      options,
      `selector ${JSON.stringify(selector)}`,
    );
  }
  async waitForFunction<T, A = unknown>(
    fn: string | ((arg: EvaluationInput<A>) => T | Promise<T>),
    arg?: A,
    options: EvaluateOptions = {},
  ): Promise<T> {
    return poll(
      async () => {
        const result = await this.evaluate(fn, arg, options);
        return result ? result : undefined;
      },
      options,
      'page function',
    );
  }
  async content(): Promise<string> {
    return this.evaluate('document.documentElement.outerHTML');
  }
  async storage(kind: 'local' | 'session' = 'local'): Promise<Record<string, string>> {
    return this.evaluate(
      (k) => {
        const s = k === 'local' ? localStorage : sessionStorage;
        return Object.fromEntries(
          Array.from({ length: s.length }, (_, i) => {
            const key = s.key(i)!;
            return [key, s.getItem(key)!];
          }),
        );
      },
      kind,
      { world: 'isolated' },
    );
  }
  async setStorage(
    values: Record<string, string>,
    kind: 'local' | 'session' = 'local',
    clear = false,
  ): Promise<void> {
    await this.evaluate(
      ({ values, kind, clear }) => {
        const s = kind === 'local' ? localStorage : sessionStorage;
        if (clear) s.clear();
        for (const [key, value] of Object.entries(values)) s.setItem(key, value);
      },
      { values, kind, clear },
      { world: 'isolated' },
    );
  }
}
export class FrameManager {
  readonly frames = new Map<string, Frame>();
  readonly sessions = new Set<Session>();
  private sessionFrames = new Map<Session, string>();
  readonly changes = new EventHub<{ frame: Frame; sameDocument: boolean; restored?: boolean }>();
  readonly setup = new Map<string, Promise<void>>();
  readonly worldName = randomUUID();
  private disposed = false;
  private subscriptions = new Map<Session, () => void>();
  mainFrame!: Frame;
  constructor(
    readonly tab: Tab,
    readonly session: Session,
  ) {
    this.track(session);
  }
  /** Adds a page or OOPIF session and routes only its events to this manager. */
  track(session: Session): void {
    this.sessions.add(session);
    if (this.subscriptions.has(session) || session.closed) return;
    this.subscriptions.set(
      session,
      session.onAny((e) => this.event(session, e)),
    );
  }
  private untrack(session: Session): void {
    this.sessions.delete(session);
    this.sessionFrames.delete(session);
    this.subscriptions.get(session)?.();
    this.subscriptions.delete(session);
  }
  private upsert(id: string, session: Session, parentId?: string): Frame {
    let frame = this.frames.get(id);
    if (!frame) {
      frame = new Frame(this, id, session);
      this.frames.set(id, frame);
    }
    if (frame.session !== session) {
      frame.invalidate();
      frame.session = session;
    }
    if (parentId) frame.parentId = parentId;
    frame.detached = false;
    return frame;
  }
  private mergeTree(tree: Protocol.Page.FrameTree, session: Session, parent?: string): void {
    if (this.disposed) return;
    const existing = this.frames.get(tree.frame.id);
    const attachedOwner = [...this.sessionFrames].find(
      ([s, id]) => id === tree.frame.id && !s.closed,
    )?.[0];
    const owner =
      attachedOwner ??
      (existing && !existing.session.closed && existing.session !== session && parent
        ? existing.session
        : session);
    const frame = this.upsert(tree.frame.id, owner, tree.frame.parentId ?? parent);
    frame.url = tree.frame.url + (tree.frame.urlFragment ?? '');
    frame.name = tree.frame.name ?? '';
    frame.loaderId = tree.frame.loaderId;
    if (session === this.session && !parent) this.mainFrame = frame;
    for (const child of tree.childFrames ?? []) this.mergeTree(child, session, tree.frame.id);
  }
  private retire(frame: Frame): void {
    for (const child of frame.children) this.retire(child);
    frame.invalidate();
    frame.detached = true;
    if (this.frames.get(frame.id) === frame) this.frames.delete(frame.id);
  }
  private async restoreTree(frame: Frame, session: Session): Promise<void> {
    const generation = frame.generation;
    const visited = new Set<Session>();
    const queue = [session];
    while (queue.length) {
      const current = queue.shift()!;
      if (visited.has(current) || current.closed) continue;
      visited.add(current);
      const { frameTree } = await current.send('Page.getFrameTree');
      if (frame.detached || frame.generation !== generation || frame.session !== session) return;
      if (current.closed) continue;
      const parent =
        current === session
          ? frame.parentId
          : this.frames.get(this.sessionFrames.get(current)!)?.parentId;
      this.mergeTree(frameTree, current, parent);
      // A parent session's tree can stop at an OOPIF boundary. Query each live
      // subtree as well; ownership survives retirement of old Frame objects.
      for (const [candidate, id] of this.sessionFrames) {
        const owned = this.frames.get(id);
        if (!visited.has(candidate) && owned && !owned.detached && owned.session === candidate)
          queue.push(candidate);
      }
    }
  }
  async initialize(session = this.session, frameId?: string): Promise<void> {
    await session.send('Page.enable');
    const { frameTree } = await session.send('Page.getFrameTree');
    this.mergeTree(frameTree, session, frameId ? this.frames.get(frameId)?.parentId : undefined);
    await session.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await session.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
      // Chromium can pause new Workers even when a target filter excludes them.
      // Accept related non-page targets so every paused target can be resumed.
      filter: [
        { type: 'browser', exclude: true },
        { type: 'tab', exclude: true },
        { type: 'page', exclude: true },
        {},
      ],
    });
    await this.tab.configureSession(session);
  }
  private event(session: Session, event: CdpEvent): void {
    if (this.disposed || !this.sessions.has(session)) return;
    const p = event.params;
    if (event.method === 'Target.attachedToTarget') {
      const e = p as Protocol.Target.AttachedToTargetEvent;
      const child = session.connection.session(e.sessionId);
      if (e.targetInfo.type !== 'iframe') {
        void child
          .sendWith('Runtime.runIfWaitingForDebugger', { timeout: 2000 })
          .catch((error) => {
            if (!child.closed) this.tab.reportError(error);
          })
          .finally(async () => {
            await session
              .sendWith('Target.detachFromTarget', { timeout: 2000 }, { sessionId: e.sessionId })
              .catch(() => {});
            session.connection.detach(e.sessionId);
          });
        return;
      }
      this.track(child);
      this.sessionFrames.set(child, e.targetInfo.targetId);
      child.disconnected.on(() => {
        this.untrack(child);
        for (const frame of this.frames.values()) if (frame.session === child) this.retire(frame);
      });
      this.upsert(e.targetInfo.targetId, child);
      const resume = () =>
        child.sendWith('Runtime.runIfWaitingForDebugger', { timeout: 2000 }).catch(() => {});
      const watchdog = setTimeout(() => {
        void resume();
      }, 5000);
      const task = this.initialize(child, e.targetInfo.targetId).finally(async () => {
        clearTimeout(watchdog);
        await resume();
      });
      this.setup.set(e.sessionId, task);
      void task
        .catch((error) => {
          if (!child.closed) this.tab.reportError(error);
        })
        .finally(() => {
          this.setup.delete(e.sessionId);
        });
    } else if (event.method === 'Target.detachedFromTarget') {
      const e = p as Protocol.Target.DetachedFromTargetEvent;
      for (const s of this.sessions)
        if (s.id === e.sessionId) {
          this.untrack(s);
          for (const f of this.frames.values())
            if (f.session === s) {
              f.invalidate();
              f.detached = true;
              this.frames.delete(f.id);
            }
        }
    } else if (event.method === 'Page.frameAttached') {
      const e = p as Protocol.Page.FrameAttachedEvent;
      const f = this.frames.get(e.frameId);
      if (f) f.parentId = e.parentFrameId;
      else this.upsert(e.frameId, session, e.parentFrameId);
    } else if (event.method === 'Page.frameNavigated') {
      const e = p as Protocol.Page.FrameNavigatedEvent;
      const f = this.upsert(e.frame.id, session, e.frame.parentId);
      f.invalidate();
      f.url = e.frame.url + (e.frame.urlFragment ?? '');
      f.loaderId = e.frame.loaderId;
      f.name = e.frame.name ?? '';
      if (session === this.session && !e.frame.parentId) this.mainFrame = f;
      // Descendants of an old document cannot survive its navigation.
      for (const child of f.children) this.retire(child);
      if (e.type === 'BackForwardCacheRestore') {
        const key = `restore:${f.id}`;
        const task = this.restoreTree(f, session);
        this.setup.set(key, task);
        void task
          .catch((error) => {
            if (!session.closed) this.tab.reportError(error);
          })
          .finally(() => {
            if (this.setup.get(key) === task) this.setup.delete(key);
          });
      }
      this.changes.emit({
        frame: f,
        sameDocument: false,
        restored: e.type === 'BackForwardCacheRestore',
      });
    } else if (event.method === 'Page.navigatedWithinDocument') {
      const e = p as Protocol.Page.NavigatedWithinDocumentEvent;
      const f = this.frames.get(e.frameId);
      if (f) {
        f.url = e.url;
        this.changes.emit({ frame: f, sameDocument: true });
      }
    } else if (event.method === 'Page.frameDetached') {
      const e = p as Protocol.Page.FrameDetachedEvent;
      const f = this.frames.get(e.frameId);
      if (f && f.session === session) {
        f.invalidate();
        if (e.reason !== 'swap') {
          this.retire(f);
        }
      }
    } else if (event.method === 'Inspector.targetCrashed') {
      this.tab.crashed = true;
      for (const f of this.frames.values()) if (f.session === session) f.invalidate();
    }
  }
  dispose(): void {
    this.disposed = true;
    for (const off of this.subscriptions.values()) off();
    this.subscriptions.clear();
    this.changes.clear();
    for (const f of this.frames.values()) {
      f.detached = true;
      f.invalidate();
    }
    this.frames.clear();
    this.sessions.clear();
    this.sessionFrames.clear();
    this.setup.clear();
  }
}
