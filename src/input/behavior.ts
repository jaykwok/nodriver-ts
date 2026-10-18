import { AsyncLocalStorage } from 'node:async_hooks';
import { delay, timeoutValue, type WaitOptions } from '../utils.js';
import { TimeoutError } from '../errors.js';

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
  completedSegments: number;
  events: number;
  trace: Array<{ type: string; x?: number; y?: number; delay?: number }>;
  cleanupErrors: string[];
}
export class InputActionError extends Error {
  override name = 'InputActionError';
  constructor(
    readonly report: InputReport,
    cause: unknown,
  ) {
    super(
      `Input ${report.action} interrupted after ${report.events} events / ${report.completedSegments} text segments: ${String(cause)}`,
      { cause },
    );
  }
}
/** A browser-wide, reentrant input lock. Calls from distinct async tasks serialize. */
export class InputCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private scope = new AsyncLocalStorage<boolean>();
  private pending = 0;
  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.scope.getStore()) return task();
    if (this.pending >= 128) return Promise.reject(new Error('Browser input queue limit reached'));
    this.pending++;
    const next = this.queue
      .then(() => this.scope.run(true, task))
      .finally(() => {
        this.pending--;
      });
    this.queue = next.catch(() => {});
    return next;
  }
}
const defaults = {
  mode: 'instant' as 'instant' | 'human',
  seed: 1,
  moveDuration: [90, 220],
  moveSteps: [8, 18],
  pause: [0, 15],
  pressDelay: [25, 70],
  keyDelay: [35, 110],
  scrollSteps: [3, 8],
  targetInset: 0.2,
  typing: 'auto' as 'auto' | 'keys' | 'insertText',
  scroll: 'auto' as 'auto' | 'wheel' | 'dom',
} satisfies Required<InputPolicy>;
export class InputBehavior {
  policy: Required<InputPolicy> = structuredClone(defaults);
  private state = 1;
  lastReport?: InputReport;
  private active = 0;
  constructor(
    readonly run: <T>(task: () => Promise<T>) => Promise<T>,
    readonly guard: () => void,
    readonly snapshotGuard: () => () => void = () => () => {},
    readonly prepare: () => Promise<void> = async () => {},
  ) {}
  configure(policy: InputPolicy): void {
    if (this.active) throw new Error('Cannot change input policy during an action');
    const next = { ...structuredClone(defaults), ...structuredClone(policy) };
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
    this.state = next.seed >>> 0;
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
  async action(
    action: string,
    options: InputOptions,
    task: (context: InputAction) => Promise<void>,
  ): Promise<InputReport> {
    const context = new InputAction(this, action, options);
    return this.run(async () => {
      this.active++;
      try {
        await context.check();
        await this.prepare();
        await context.check();
        await task(context);
        await context.check();
        return context.report;
      } catch (error) {
        context.report.status = 'interrupted';
        throw new InputActionError(context.report, error);
      } finally {
        this.active--;
        this.lastReport = structuredClone(context.report);
      }
    });
  }
}
export interface InputOptions extends WaitOptions {
  /** Internal/action guard, checked between each irreversible input. */
  guard?: () => void | Promise<void>;
}
export class InputAction {
  readonly report: InputReport;
  readonly end: number;
  private documentGuard: () => void;
  constructor(
    readonly behavior: InputBehavior,
    action: string,
    readonly options: InputOptions,
  ) {
    this.end = performance.now() + timeoutValue(options.timeout ?? 10000);
    this.documentGuard = behavior.snapshotGuard();
    this.report = {
      action,
      status: 'completed',
      seed: behavior.policy.seed,
      completedSegments: 0,
      events: 0,
      trace: [],
      cleanupErrors: [],
    };
  }
  async check(): Promise<void> {
    this.options.signal?.throwIfAborted();
    if (performance.now() >= this.end) throw new TimeoutError('Input deadline exceeded');
    this.behavior.guard();
    this.documentGuard();
    await this.options.guard?.();
  }
  record(type: string, fields: { x?: number; y?: number; delay?: number } = {}): void {
    this.report.events++;
    if (this.report.trace.length < 2000) this.report.trace.push({ type, ...fields });
  }
  async wait(ms: number): Promise<void> {
    await this.check();
    if (ms) {
      if (this.report.trace.length < 2000) this.report.trace.push({ type: 'pause', delay: ms });
      await delay(Math.min(ms, Math.max(0, this.end - performance.now())), this.options.signal);
    }
    await this.check();
  }
}
