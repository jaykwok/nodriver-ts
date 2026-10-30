import { bounded, delay, timeoutValue, type WaitOptions } from '../utils.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { StaleElementError, TimeoutError } from '../errors.ts';
import type { Command, Connection, Params, Result, Session } from '../protocol/connection.ts';
import {
  InputBlockedError,
  type InputBehavior,
  type InputOptions,
  type InputReport,
  type InputCleanupReport,
} from './behavior.ts';
export interface InputRelease {
  run(): Promise<void>;
  forget(): void;
}
export class InputAction {
  readonly report: InputReport;
  readonly end: number;
  readonly behavior: InputBehavior;
  readonly options: InputOptions;
  readonly cleanup: Promise<InputCleanupReport>;
  private resolveCleanup!: (report: InputCleanupReport) => void;
  private documentGuard: () => void;
  private controller = new AbortController();
  private releases: InputRelease[] = [];
  private retained = new Set<InputRelease>();
  private acquired = false;
  private connections = new Set<Connection>();
  private debt = false;
  private finishing?: Promise<InputCleanupReport>;
  private cleanupEnd?: number;
  private stepQueue: Promise<unknown> = Promise.resolve();
  private activeStep = new AsyncLocalStorage<{ live: boolean }>();
  private stepOptions?: InputOptions;
  private stepEnd = Infinity;
  private disposers: Array<() => void> = [];
  private watchedFrames = new Map<Session, Set<string | undefined>>();
  private tasks = new Set<Promise<unknown>>();
  track(task: Promise<unknown>): void {
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
  }
  reason?: unknown;
  start(): void {
    this.acquired = true;
    this.report.phase = 'running';
  }
  retain(release: InputRelease): void {
    this.retained.add(release);
  }
  observe(session: Session): void {
    this.connections.add(session.connection);
  }
  constructor(behavior: InputBehavior, action: string, options: InputOptions) {
    this.behavior = behavior;
    this.options = options;
    this.end = performance.now() + timeoutValue(options.timeout ?? 10000);
    timeoutValue(options.cleanupTimeout ?? 5000);
    this.cleanup = new Promise((resolve) => {
      this.resolveCleanup = resolve;
    });
    this.documentGuard = behavior.snapshotGuard();
    this.report = {
      action,
      status: 'completed',
      seed: behavior.policy.seed,
      randomState: behavior.randomState,
      completedSegments: 0,
      events: 0,
      trace: [],
      cleanupErrors: [],
      phase: 'queued',
      cleanup: 'pending',
    };
  }
  interrupt(error: unknown): void {
    if (this.controller.signal.aborted) return;
    this.reason = error;
    this.report.status = 'interrupted';
    this.cleanupEnd ??= performance.now() + (this.options.cleanupTimeout ?? 5000);
    if (this.report.phase !== 'done') this.report.phase = 'cleaning';
    this.controller.abort(error);
  }
  step(): WaitOptions {
    if (this.finishing) throw new InputBlockedError('Input action has ended');
    if (this.controller.signal.aborted) throw this.reason;
    if (this.report.cleanupErrors.length) throw new InputBlockedError('Input cleanup failed');
    this.options.signal?.throwIfAborted();
    this.stepOptions?.signal?.throwIfAborted();
    const timeout = Math.min(this.end, this.stepEnd) - performance.now();
    if (timeout <= 0) throw new TimeoutError('Input deadline exceeded');
    const signals = [this.controller.signal, this.options.signal, this.stepOptions?.signal].filter(
      (s): s is AbortSignal => !!s,
    );
    return { timeout, signal: AbortSignal.any(signals) };
  }
  waitFor<T>(promise: Promise<T>): Promise<T> {
    try {
      return bounded(promise, this.step(), 'Input action');
    } catch (error) {
      void promise.catch(() => {});
      return Promise.reject(error);
    }
  }
  async check(): Promise<void> {
    this.step();
    this.behavior.guard();
    this.documentGuard();
    await this.waitFor(Promise.resolve().then(() => this.options.guard?.()));
    if (this.stepOptions?.guard)
      await this.waitFor(Promise.resolve().then(() => this.stepOptions!.guard!()));
    this.step();
    this.behavior.guard();
    this.documentGuard();
  }
  async send<M extends Command>(
    session: Session,
    method: M,
    ...params: Params<M>
  ): Promise<Result<M>> {
    const options = this.step();
    this.connections.add(session.connection);
    try {
      return await session.sendWith(method, options, ...params);
    } catch (error) {
      this.debt = true;
      throw error;
    }
  }
  cleanupStep(): WaitOptions {
    if (this.report.phase !== 'cleaning' && this.report.phase !== 'done')
      return { timeout: this.options.cleanupTimeout ?? 5000 };
    this.cleanupEnd ??= performance.now() + (this.options.cleanupTimeout ?? 5000);
    const timeout = this.cleanupEnd - performance.now();
    if (timeout <= 0) throw new TimeoutError('Input cleanup deadline exceeded');
    return { timeout };
  }
  async sendCleanup<M extends Command>(
    session: Session,
    method: M,
    ...params: Params<M>
  ): Promise<Result<M>> {
    this.connections.add(session.connection);
    try {
      return await session.sendWith(method, this.cleanupStep(), ...params);
    } catch (error) {
      this.debt = true;
      throw error;
    }
  }
  release(task: () => Promise<void>): InputRelease {
    this.step();
    let forgotten = false,
      pending: Promise<void> | undefined;
    const release: InputRelease = {
      forget() {
        forgotten = true;
      },
      run: () => {
        if (forgotten) return Promise.resolve();
        return (pending ??= (async () => {
          try {
            await task();
          } catch (error) {
            this.cleanupFailed(error);
          }
        })());
      },
    };
    this.releases.push(release);
    return release;
  }
  cleanupFailed(error: unknown): void {
    this.report.cleanupErrors.push(String(error));
    this.behavior.coordinator?.block(error);
  }
  perform(
    options: InputOptions,
    task: (action: InputAction) => Promise<void>,
  ): Promise<InputReport> {
    if (this.finishing) return Promise.reject(new InputBlockedError('Input action has ended'));
    const end =
      options.timeout === undefined ? Infinity : performance.now() + timeoutValue(options.timeout);
    const execute = async () => {
      const previous = this.stepOptions,
        previousEnd = this.stepEnd;
      this.stepOptions = {
        ...options,
        signal:
          previous?.signal && options.signal
            ? AbortSignal.any([previous.signal, options.signal])
            : (options.signal ?? previous?.signal),
        guard: async () => {
          await previous?.guard?.();
          await options.guard?.();
        },
      };
      this.stepEnd = Math.min(previousEnd, end);
      try {
        await this.check();
        await task(this);
        await this.check();
        return this.report;
      } catch (error) {
        this.interrupt(error);
        throw error;
      } finally {
        this.stepOptions = previous;
        this.stepEnd = previousEnd;
      }
    };
    const reentrant = this.activeStep.getStore()?.live;
    const next = reentrant
      ? execute()
      : this.stepQueue.then(() => {
          const token = { live: true };
          return this.activeStep.run(token, async () => {
            try {
              return await execute();
            } finally {
              token.live = false;
            }
          });
        });
    if (!reentrant) this.stepQueue = next;
    this.track(next);
    const waiting = bounded(
      // A queued child signal/deadline also stops the containing scope immediately.
      next,
      {
        timeout: Math.max(0, Math.min(this.end, end) - performance.now()),
        signal: AbortSignal.any(
          [this.controller.signal, this.options.signal, options.signal].filter(
            (signal): signal is AbortSignal => !!signal,
          ),
        ),
      },
      'Input step',
    ).catch((error) => {
      this.interrupt(error);
      throw error;
    });
    void waiting.catch(() => {});
    return waiting;
  }
  async flush(): Promise<void> {
    await this.waitFor(this.stepQueue.then(() => {}));
  }
  disposeWith(task: () => void): void {
    this.disposers.push(task);
  }
  // Raw sessions have no frame model and conservatively watch the entire session.
  watch(session: Session, frameId?: string): void {
    let frames = this.watchedFrames.get(session);
    if (frames?.has(frameId)) return;
    if (!frames) {
      this.watchedFrames.set(session, (frames = new Set()));
      this.disposeWith(session.disconnected.on((error) => this.interrupt(error)));
    }
    frames.add(frameId);
    this.observe(session);
    this.disposeWith(
      session.on('Page.frameNavigated', ({ frame }) => {
        if (frameId === undefined || frame.id === frameId)
          this.interrupt(new StaleElementError('Document changed during input'));
      }),
    );
    this.disposeWith(
      session.on('Page.frameDetached', (event) => {
        if (frameId === undefined || event.frameId === frameId)
          this.interrupt(new StaleElementError('Frame detached during input'));
      }),
    );
  }
  finish(): Promise<InputCleanupReport> {
    return (this.finishing ??= (async () => {
      this.report.phase = 'cleaning';
      if (this.acquired) this.behavior.coordinator?.cleaningStarted();
      try {
        if (this.tasks.size) {
          try {
            await bounded(
              Promise.allSettled([...this.tasks]),
              this.cleanupStep(),
              'Input task cleanup',
            );
          } catch (error) {
            this.report.cleanupErrors.push(String(error));
            this.behavior.coordinator?.block(error);
          }
        }
        for (const release of [...this.releases].reverse()) {
          // Standalone down() transfers ownership only after the complete action succeeds.
          if (
            this.retained.has(release) &&
            this.report.status === 'completed' &&
            !this.report.cleanupErrors.length
          )
            continue;
          await release.run();
        }
        if (
          this.debt ||
          // The action timer can win before send() has recorded its rejection.
          [...this.connections].some((c) => c.pendingCount > 0 || c.unansweredCount > 0 || c.closed)
        )
          for (const connection of this.connections) {
            try {
              await connection.drain(this.cleanupStep());
            } catch (error) {
              this.report.cleanupErrors.push(String(error));
              this.behavior.coordinator?.block(error);
            }
          }
        for (const release of [...this.retained].reverse()) {
          if (this.report.status === 'completed' && !this.report.cleanupErrors.length)
            release.forget();
          else await release.run();
        }
      } finally {
        if (this.acquired) this.behavior.coordinator?.cleaningFinished();
        for (const dispose of this.disposers) dispose();
      }
      this.report.cleanup = this.report.cleanupErrors.length
        ? [...this.connections].some((c) => c.closed)
          ? 'disconnected'
          : 'failed'
        : 'completed';
      if (this.report.cleanup !== 'completed') this.report.status = 'interrupted';
      this.report.phase = 'done';
      const result: InputCleanupReport = {
        status: this.report.cleanup,
        report: structuredClone(this.report),
      };
      this.resolveCleanup(result);
      return result;
    })());
  }
  record(type: string, fields: { x?: number; y?: number; delay?: number } = {}): void {
    this.report.events++;
    if (this.report.trace.length < 2000) this.report.trace.push({ type, ...fields });
  }
  async wait(ms: number): Promise<void> {
    await this.check();
    if (ms) {
      if (this.report.trace.length < 2000) this.report.trace.push({ type: 'pause', delay: ms });
      await this.waitFor(
        delay(Math.min(ms, Math.max(0, this.end - performance.now())), this.step().signal),
      );
    }
    await this.check();
  }
}
