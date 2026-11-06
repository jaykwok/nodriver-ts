import { AsyncLocalStorage } from 'node:async_hooks';
import { randomInt } from 'node:crypto';
import { abortReason, type WaitOptions } from '../utils.ts';
import { NodriverError, TimeoutError } from '../errors.ts';
import {
  requestLedger,
  type Command,
  type Connection,
  type Session,
} from '../protocol/connection.ts';
import type { Protocol } from 'devtools-protocol';
import { InputTargets, type InputPage } from './targets.ts';
import { InputAction } from './action.ts';
export { InputAction } from './action.ts';

export interface InputPolicy {
  mode?: 'instant' | 'human';
  seed?: number;
  moveDuration?: [number, number];
  moveSteps?: [number, number];
  pause?: [number, number];
  pressDelay?: [number, number];
  keyDelay?: [number, number];
  scrollSteps?: [number, number];
  /** Fraction of the visible target excluded at each edge, in [0, .45]. */
  targetInset?: number;
  /**
   * How type() enters text: physical key events for US-layout characters, or Input.insertText.
   * "auto" uses keys in human mode and insertText in instant mode.
   */
  typing?: 'auto' | 'keys' | 'insertText';
  /** How element actions scroll: "auto" uses wheel events in human mode, DOM scrolling otherwise. */
  scroll?: 'auto' | 'wheel' | 'dom';
}
export interface InputReport {
  action: string;
  status: 'completed' | 'interrupted';
  seed: number;
  /** PRNG state when this action acquired the input lock, before its first draw. */
  randomState: number;
  completedSegments: number;
  events: number;
  /**
   * Input commands sent that can change the page: button presses and releases, keys, text and
   * composition, counted when sent rather than when acknowledged. Moves and wheel scrolling are not
   * counted.
   */
  dispatched: number;
  trace: Array<{ type: string; x?: number; y?: number; delay?: number }>;
  cleanupErrors: string[];
  phase: 'queued' | 'running' | 'cleaning' | 'done';
  cleanup: 'pending' | 'completed' | 'failed' | 'disconnected';
}
export interface InputCleanupReport {
  status: Exclude<InputReport['cleanup'], 'pending'>;
  report: InputReport;
}
export class InputActionError extends NodriverError {
  override name = 'InputActionError';
  readonly report: InputReport;
  readonly cleanup: Promise<InputCleanupReport>;
  constructor(report: InputReport, cause: unknown, cleanup?: Promise<InputCleanupReport>) {
    super(
      `Input ${report.action} interrupted after ${report.events} events / ${report.completedSegments} text segments: ${String(cause)}`,
      { cause },
    );
    this.report = report;
    this.cleanup = cleanup ?? Promise.resolve({ status: 'completed', report });
  }
}
export class InputBlockedError extends NodriverError {
  override name = 'InputBlockedError';
}
/** A connection-wide, reentrant input lock. Calls from distinct async tasks serialize. */
export class InputCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private scope = new AsyncLocalStorage<{ live: boolean; barriers: Set<Promise<unknown>> }>();
  private pending = 0;
  private failure?: InputBlockedError;
  private cleaning = 0;
  private readonly targets?: InputTargets;
  /** Managed holds by page, or by session when the page is unknown. */
  private readonly held = new Map<string, InputPage | undefined>();
  constructor(connection?: Connection) {
    if (connection) this.targets = new InputTargets(connection);
  }
  /** @internal Records ownership established by Browser/Tab, without CDP setup. */
  registerTarget(info: Protocol.Target.TargetInfo): void {
    this.targets?.registerTarget(info);
  }
  /** @internal */
  registerSession(session: Session, pageId: string): void {
    this.targets?.registerSession(session, pageId);
  }
  /** @internal Capture ownership before a session can detach or its page can disappear. */
  pageFor(session: Session): InputPage | undefined {
    return this.targets?.pageFor(session);
  }
  /** @internal Whether a JavaScript dialog is open on the page, by default the session's page. */
  dialogOpen(session: Session, page?: InputPage): boolean {
    return this.targets?.dialogOpen(session, page) ?? false;
  }
  /** @internal Calls `listener` after a page closes, a dialog opens or closes, or the connection closes. */
  onPages(listener: () => void): () => void {
    return this.targets?.changes.on(listener) ?? (() => {});
  }
  assertSessionReady(session: Session): void {
    this.assertReady();
    const page = this.pageFor(session);
    if (page?.failure) throw page.failure;
    if (!page && this.targets?.hasBlockedPage)
      throw new InputBlockedError(
        'Input page ownership is unknown while a page is blocked; use a known page session',
      );
  }
  /** Called only after all releases and late replies have settled. */
  blockComposition(cause: unknown, page?: InputPage): void {
    // A destroyed page takes its held keys and buttons with it.
    for (const [key, owner] of this.held) if (owner?.destroyed) this.held.delete(key);
    if (!page || this.held.size) {
      this.block(cause);
      return;
    }
    if (!page.destroyed)
      page.failure ??= new InputBlockedError(
        `Composition cleanup was not confirmed for page ${page.id}; inspect and restore its state, then call inputScope.recoverComposition(), or close this page`,
        { cause },
      );
  }
  /** @internal Explicit acknowledgement after the caller inspected/restored the page. */
  recoverComposition(session: Session): Promise<boolean> {
    // Capture the failure the caller inspected; never clear a newer failure queued ahead of us.
    const page = this.pageFor(session),
      failure = page?.failure;
    return this.run(async () => {
      if (session.closed)
        throw new InputBlockedError('Cannot recover input on a closed session', {
          cause: session.closeReason,
        });
      if (!page || page.destroyed || this.pageFor(session) !== page)
        throw new InputBlockedError('Composition recovery requires a known live page');
      if (!page.failure) return false;
      if (page.failure !== failure)
        throw new InputBlockedError('Composition failure changed; inspect the page again');
      // The failed action drained its replies before blocking, and managed input on this page has
      // been refused since; other pages' work and holds do not affect its composition.
      for (const [key, owner] of this.held) if (owner?.destroyed) this.held.delete(key);
      if ([...this.held.values()].some((owner) => !owner || owner === page))
        throw new InputBlockedError(
          'Release managed keys and buttons of this page before composition recovery',
        );
      page.failure = undefined;
      return true;
    });
  }
  /**
   * Track managed holds before dispatch; only an acknowledged release clears a hold. Attachments
   * of one page share its input state, so a release through any of them counts.
   */
  trackCommand(session: Session, method: Command, params: unknown): () => void {
    let control: string | undefined;
    let release = false;
    if (method === 'Input.dispatchKeyEvent') {
      const key = params as Protocol.Input.DispatchKeyEventRequest;
      if (key.type === 'keyDown' || key.type === 'rawKeyDown' || key.type === 'keyUp') {
        control = `key:${key.code ?? key.windowsVirtualKeyCode ?? key.key}`;
        release = key.type === 'keyUp';
      }
    } else if (method === 'Input.dispatchMouseEvent') {
      const mouse = params as Protocol.Input.DispatchMouseEventRequest;
      if (mouse.type === 'mousePressed' || mouse.type === 'mouseReleased') {
        control = `mouse:${mouse.button}`;
        release = mouse.type === 'mouseReleased';
      }
    }
    if (!control) return () => {};
    const page = this.pageFor(session);
    const key = `${page ? 'page:' + page.id : 'session:' + session.id}:${control}`;
    if (!release) this.held.set(key, page);
    return () => {
      if (release) this.held.delete(key);
    };
  }
  /** The connection-wide block, once cleanup could not be confirmed; managed input then fails. */
  get blocked(): InputBlockedError | undefined {
    return this.failure;
  }
  assertReady(): void {
    if (this.failure) throw this.failure;
    if (this.cleaning) throw new InputBlockedError('Input cleanup is still in progress');
  }
  block(cause: unknown): void {
    this.failure ??= new InputBlockedError(
      'Input cleanup was not confirmed; use a new connection',
      { cause },
    );
  }
  hold(cleanup: Promise<unknown>): void {
    // A nested action may reject before cleanup ends; the outer owner must still wait.
    this.scope.getStore()?.barriers.add(cleanup);
  }
  cleaningStarted(): void {
    this.cleaning++;
  }
  cleaningFinished(): void {
    this.cleaning--;
  }
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()?.live) {
      try {
        this.assertReady();
        return task();
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.pending >= 128) return Promise.reject(new Error('Browser input queue limit reached'));
    this.pending++;
    const next = this.queue
      .then(() => {
        const scope = { live: true, barriers: new Set<Promise<unknown>>() };
        return this.scope.run(scope, async () => {
          try {
            this.assertReady();
            return await task();
          } finally {
            while (scope.barriers.size) {
              const barriers = [...scope.barriers];
              scope.barriers.clear();
              await Promise.allSettled(barriers);
            }
            scope.live = false;
          }
        });
      })
      .finally(() => {
        this.pending--;
      });
    this.queue = next.catch(() => {});
    return next;
  }
}
const coordinators = new WeakMap<Connection, InputCoordinator>();
/** @internal One queue for Tab input and every raw scope on this connection. */
export function inputCoordinator(connection: Connection): InputCoordinator {
  let value = coordinators.get(connection);
  if (!value) coordinators.set(connection, (value = new InputCoordinator(connection)));
  return value;
}
const defaults = {
  mode: 'instant' as 'instant' | 'human',
  moveDuration: [90, 220],
  moveSteps: [8, 18],
  pause: [0, 15],
  pressDelay: [25, 70],
  keyDelay: [35, 110],
  scrollSteps: [3, 8],
  targetInset: 0.2,
  typing: 'auto' as 'auto' | 'keys' | 'insertText',
  scroll: 'auto' as 'auto' | 'wheel' | 'dom',
} satisfies Omit<Required<InputPolicy>, 'seed'>;
/** @internal Rejects a policy configure() would reject; returns a copy to keep. */
export function checkedInputPolicy(policy: InputPolicy): InputPolicy {
  new InputBehavior(
    (task) => task(),
    () => {},
  ).configure(policy);
  return structuredClone(policy);
}
export class InputBehavior {
  policy: Required<InputPolicy>;
  /** @internal Modifier state shared by this behavior's mouse and keyboard. */
  modifiers = 0;
  private state: number;
  lastReport?: InputReport;
  private active = new Set<InputAction>();
  private context = new AsyncLocalStorage<InputAction>();
  get current(): InputAction | undefined {
    return this.context.getStore();
  }
  readonly run: <T>(task: () => Promise<T>) => Promise<T>;
  readonly guard: () => void;
  readonly snapshotGuard: () => () => void;
  readonly prepare: (action: InputAction) => Promise<void>;
  coordinator?: InputCoordinator;
  constructor(
    run: <T>(task: () => Promise<T>) => Promise<T>,
    guard: () => void,
    snapshotGuard: () => () => void = () => () => {},
    prepare: (action: InputAction) => Promise<void> = async () => {},
    seedSource: () => number = () => randomInt(0, 0x1_0000_0000),
  ) {
    // One independent stream per behavior (normally per Tab), including instant mode.
    const seed = seedSource();
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff)
      throw new RangeError('Invalid generated input seed');
    this.policy = { ...structuredClone(defaults), seed };
    this.state = seed;
    this.run = run;
    this.guard = guard;
    this.snapshotGuard = snapshotGuard;
    this.prepare = prepare;
  }
  configure(policy: InputPolicy): void {
    if ([...this.active].some((action) => action.report.phase !== 'done'))
      throw new Error('Cannot change input policy during an action');
    const next = {
      ...structuredClone(defaults),
      ...structuredClone(policy),
      seed: policy.seed === undefined ? this.policy.seed : policy.seed,
    };
    if (!['instant', 'human'].includes(next.mode) || !Number.isSafeInteger(next.seed))
      throw new TypeError('Invalid input mode or seed');
    if (!['auto', 'keys', 'insertText'].includes(next.typing))
      throw new TypeError('Invalid typing mode');
    if (!['auto', 'wheel', 'dom'].includes(next.scroll)) throw new TypeError('Invalid scroll mode');
    for (const field of [
      'moveDuration',
      'moveSteps',
      'pause',
      'pressDelay',
      'keyDelay',
      'scrollSteps',
    ] as const) {
      const range = next[field];
      const steps = field.endsWith('Steps');
      if (
        range.length !== 2 ||
        range.some(
          (n) =>
            !Number.isFinite(n) ||
            n < (steps ? 1 : 0) ||
            n > (steps ? 120 : 3000) ||
            (steps && !Number.isInteger(n)),
        ) ||
        range[0] > range[1]
      )
        throw new RangeError(`Invalid ${field} range`);
    }
    if (!Number.isFinite(next.targetInset) || next.targetInset < 0 || next.targetInset > 0.45)
      throw new RangeError('Invalid targetInset');
    this.policy = next;
    // Reconfiguration without an explicit seed preserves the stream, even when changing mode.
    if (policy.seed !== undefined) this.state = next.seed >>> 0;
  }
  get randomState(): number {
    return this.state;
  }
  random(): number {
    this.state = (Math.imul(1664525, this.state) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }
  range(
    field: 'moveDuration' | 'moveSteps' | 'pause' | 'pressDelay' | 'keyDelay' | 'scrollSteps',
  ): number {
    const [low, high] = this.policy[field];
    const value = low + (high - low) * this.random();
    return field.endsWith('Steps') ? Math.round(value) : value;
  }
  action(
    action: string,
    options: InputOptions,
    task: (context: InputAction) => Promise<void>,
  ): Promise<InputReport> {
    if (this.current) return this.current.perform(options, task);
    const context = new InputAction(this, action, options);
    return new Promise((resolve, reject) => {
      let started = false,
        settled = false;
      const fail = (error: unknown) => {
        context.interrupt(error);
        if (!settled) {
          settled = true;
          reject(new InputActionError(structuredClone(context.report), error, context.cleanup));
        }
        if (!started) void context.finish();
      };
      const timer = setTimeout(
        () => fail(new TimeoutError('Input deadline exceeded')),
        Math.max(0, context.end - performance.now()),
      );
      const abort = () => fail(abortReason(options.signal!));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      void this.run(async () => {
        if (settled) return;
        started = true;
        this.coordinator?.hold(context.cleanup);
        this.active.add(context);
        context.start();
        context.report.seed = this.policy.seed;
        context.report.randomState = this.state;
        try {
          this.coordinator?.assertReady();
          await context.check();
          await context.waitFor(
            this.context.run(context, () =>
              requestLedger.run(context.recordRequest, () => this.prepare(context)),
            ),
          );
          await context.check();
          const running = this.context.run(context, () =>
            requestLedger.run(context.recordRequest, () => task(context)),
          );
          context.track(running);
          await context.waitFor(running);
          await context.flush();
          await context.check();
        } catch (error) {
          fail(context.reason ?? error);
        } finally {
          clearTimeout(timer);
          await context.finish();
          options.signal?.removeEventListener('abort', abort);
          this.active.delete(context);
          this.lastReport = structuredClone(context.report);
          if (!settled) {
            if (context.report.status === 'interrupted')
              fail(
                context.reason ??
                  new InputBlockedError('Input cleanup failed', { cause: context.cleanupError }),
              );
            else {
              settled = true;
              resolve(structuredClone(context.report));
            }
          }
        }
      })
        .catch(fail)
        .finally(() => {
          clearTimeout(timer);
          options.signal?.removeEventListener('abort', abort);
        });
    });
  }
}
export interface InputOptions extends WaitOptions {
  /** Independent total budget for releases and late responses. Defaults to 5000 ms. */
  cleanupTimeout?: number;
  /** Internal/action guard, checked between each irreversible input. */
  guard?: () => void | Promise<void>;
}
