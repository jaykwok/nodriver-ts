import { bounded, delay, MAX_TIMEOUT, timeoutValue, type WaitOptions } from '../utils.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { DisconnectedError, ProtocolError, StaleElementError, TimeoutError } from '../errors.ts';
import { isContextGone } from '../page/execution-context.ts';
import {
  REQUEST_LEDGER,
  type RequestRecorder,
  type Command,
  type Connection,
  type LedgerOptions,
  type Params,
  type Result,
  type Session,
} from '../protocol/connection.ts';
import type { Protocol } from 'devtools-protocol';
import type { InputPage } from './targets.ts';
import {
  InputBlockedError,
  inputCoordinator,
  type InputBehavior,
  type InputCheckpoint,
  type InputOptions,
  type InputReport,
  type InputCleanupReport,
  type InputSent,
} from './behavior.ts';
import { PresentationRecovery } from './recovery.ts';
export interface InputRelease {
  run(): Promise<void>;
  forget(): void;
}
/** A failed cleanup step, decided once the action's replies have settled. */
interface CleanupFailure {
  error: unknown;
  /** The page whose input state the step concerned, as captured when the action used it. */
  page?: InputPage;
  /** A failed composition cancel blocks only its page. */
  composition: boolean;
  /** The step's session had already ended; if its page closed, the closure failed the step. */
  sessionEnded: boolean;
  /** The page closed and took its input state with it. */
  dropped?: boolean;
}
function isObjectGone(error: unknown): boolean {
  return (
    isContextGone(error) ||
    (error instanceof ProtocolError && /Could not find object with given id/.test(error.message))
  );
}
/**
 * What is known about the session's pages and dialogs. It comes from the session's own connection,
 * which a raw command of a scope callback can make another than the action's.
 */
function pages(session: Session) {
  return inputCoordinator(session.connection);
}
const mouseKinds: Record<string, keyof InputSent> = {
  mouseMoved: 'moves',
  mouseWheel: 'wheels',
  mousePressed: 'presses',
  mouseReleased: 'releases',
};
const keyKinds: Record<string, keyof InputSent> = {
  rawKeyDown: 'keys',
  keyDown: 'keys',
  char: 'characters',
  keyUp: 'releases',
};
/** The kind of input a command sends, as the report counts it; undefined for other commands. */
function inputKind(method: string, params: unknown): keyof InputSent | undefined {
  switch (method) {
    case 'Input.dispatchMouseEvent':
      return mouseKinds[(params as Protocol.Input.DispatchMouseEventRequest).type];
    case 'Input.dispatchKeyEvent':
      return keyKinds[(params as Protocol.Input.DispatchKeyEventRequest).type];
    case 'Input.insertText':
      return 'text';
    case 'Input.imeSetComposition':
      return 'composition';
  }
}
/**
 * A cleanup budget that runs only while no JavaScript dialog is open on the action's pages: Chrome
 * holds the replies to input a page was handling until its dialog closes. The budget restarts
 * when the dialog closes.
 */
class CleanupDeadline {
  private readonly controller = new AbortController();
  private readonly budget: number;
  private readonly paused: () => boolean;
  private readonly watch: (listener: () => void) => () => void;
  private end: number;
  private timer?: ReturnType<typeof setTimeout>;
  private unwatch?: () => void;
  constructor(budget: number, paused: () => boolean, watch: (listener: () => void) => () => void) {
    this.budget = budget;
    this.paused = paused;
    this.watch = watch;
    this.end = performance.now() + budget;
    this.check();
  }
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  /** Options for one wait. The signal enforces the budget; the timeout only bounds the timer. */
  get options(): WaitOptions {
    return { timeout: MAX_TIMEOUT, signal: this.controller.signal };
  }
  private readonly check = (): void => {
    clearTimeout(this.timer);
    this.unwatch?.();
    this.unwatch = undefined;
    if (this.controller.signal.aborted) return;
    if (this.paused()) {
      this.unwatch = this.watch(() => {
        this.end = performance.now() + this.budget;
        this.check();
      });
      return;
    }
    const left = this.end - performance.now();
    if (left > 0) this.timer = setTimeout(this.check, left);
    else this.controller.abort(new TimeoutError('Input cleanup deadline exceeded'));
  };
  dispose(): void {
    clearTimeout(this.timer);
    this.unwatch?.();
  }
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
  /** Sessions the action used, with the page each belonged to; known only while it lives. */
  private sessions = new Map<Session, InputPage | undefined>();
  /** IDs of this action's own requests, per connection, until they are answered. */
  private requests = new Map<Connection, Set<number>>();
  private recording = true;
  private recovery?: PresentationRecovery;
  /** When the action acquired input. */
  private started = 0;
  /**
   * Where planned delays count from: when the previous input was sent, or when the previous delay
   * was planned to end.
   */
  private paced?: number;
  /**
   * @internal Records a request of this action: its own sends and any command issued in its
   * async context, such as element preparation or a scope callback's raw command.
   */
  readonly recordRequest: RequestRecorder = (connection, id, method, session, params) => {
    if (!this.recording) return;
    // Cleanup covers every connection and session the action used, even one reached only by a
    // raw command.
    this.connections.add(connection);
    if (session) this.use(session);
    let ids = this.requests.get(connection);
    if (!ids) this.requests.set(connection, (ids = new Set()));
    // Long actions drop answered IDs as they go.
    else if (ids.size >= 1024) connection.outstanding(ids);
    ids.add(id);
    return {
      sent: () => {
        this.sending(method, params);
        if (session && method.startsWith('Input.')) this.recovery?.watch(connection, id, session);
      },
      replied: this.replied,
    };
  };
  private readonly replied = (late: boolean): void => {
    if (late && this.report.phase !== 'done') this.report.lateReplies++;
  };
  private failures: CleanupFailure[] = [];
  private finishing?: Promise<InputCleanupReport>;
  private finished = false;
  private readonly cleanupBudget: number;
  /** The budget that every cleanup step shares once the action is cleaning up. */
  private cleanupDeadline?: CleanupDeadline;
  /** Trace notes recorded once per action. */
  private noted = new Set<string>();
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
    this.started = performance.now();
    this.report.phase = 'running';
    const after = this.behavior.policy.presentationRecovery;
    if (after === false) return;
    const recovery = (this.recovery = new PresentationRecovery(
      after,
      (session) => this.recoverPresentation(session),
      (session) => pages(session).dialogOpen(session, this.sessions.get(session)),
    ));
    this.disposeWith(() => recovery.dispose());
  }
  /**
   * Draws a frame of the session's page so that Chrome delivers the input it holds back. Chrome
   * captures only top-level targets, so a frame's input recovers through a session of its page.
   * The screenshot is a request of this action, so cleanup waits for it as well.
   */
  private recoverPresentation(session: Session): void {
    const target = pages(session).pageSession(session, this.sessions.get(session)) ?? session;
    this.report.presentationRecoveries++;
    this.note('presentationRecovery');
    target
      .sendWith('Page.captureScreenshot', this.ledger({ timeout: this.cleanupBudget }), {
        format: 'jpeg',
        quality: 0,
        optimizeForSpeed: true,
      })
      .catch(() => {});
  }
  retain(release: InputRelease): void {
    this.retained.add(release);
  }
  observe(session: Session): void {
    this.behavior.coordinator?.assertSessionReady(session);
    this.use(session);
  }
  /** Records a session the action used, and its page while that is still known. */
  private use(session: Session): void {
    this.connections.add(session.connection);
    if (!this.sessions.get(session)) this.sessions.set(session, pages(session).pageFor(session));
  }
  constructor(behavior: InputBehavior, action: string, options: InputOptions) {
    this.behavior = behavior;
    this.options = options;
    this.end = performance.now() + timeoutValue(options.timeout ?? 10000);
    this.cleanupBudget = timeoutValue(options.cleanupTimeout ?? 5000);
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
      dispatched: 0,
      sent: {
        moves: 0,
        wheels: 0,
        presses: 0,
        keys: 0,
        characters: 0,
        releases: 0,
        text: 0,
        composition: 0,
      },
      skippedMoves: 0,
      lateReplies: 0,
      presentationRecoveries: 0,
      plannedMs: 0,
      actualMs: 0,
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
    if (this.report.phase !== 'done') {
      this.inputEnded();
      this.cleanupDeadline ??= this.deadline();
    }
    this.controller.abort(error);
  }
  /** Input has ended, and cleanup begins. */
  private inputEnded(): void {
    if (this.report.phase === 'running') this.report.actualMs = performance.now() - this.started;
    this.report.phase = 'cleaning';
  }
  /** The first cleanup failure that stands, as the cause of "Input cleanup failed". */
  get cleanupError(): unknown {
    return this.failures.find((failure) => !failure.dropped)?.error;
  }
  step(): WaitOptions {
    if (this.finishing) throw new InputBlockedError('Input action has ended');
    if (this.controller.signal.aborted) throw this.reason;
    if (this.failures.length)
      throw new InputBlockedError('Input cleanup failed', { cause: this.cleanupError });
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
  /** Checks that the action may go on, calling its guards with the checkpoint reached. */
  async check(checkpoint: InputCheckpoint = { type: 'step' }): Promise<void> {
    this.step();
    this.behavior.guard();
    this.documentGuard();
    await this.waitFor(Promise.resolve().then(() => this.options.guard?.(checkpoint)));
    if (this.stepOptions?.guard)
      await this.waitFor(Promise.resolve().then(() => this.stepOptions!.guard!(checkpoint)));
    this.step();
    this.behavior.guard();
    this.documentGuard();
  }
  async send<M extends Command>(
    session: Session,
    method: M,
    ...params: Params<M>
  ): Promise<Result<M>> {
    return this.sendAcknowledged(session, method, undefined, ...params);
  }
  /** Observes a successful reply even when cancellation made the caller stop waiting for it. */
  async sendAcknowledged<M extends Command>(
    session: Session,
    method: M,
    confirmed: (() => void) | undefined,
    ...params: Params<M>
  ): Promise<Result<M>> {
    const options = this.step();
    this.observe(session);
    let observed = false;
    const confirm =
      confirmed &&
      (() => {
        if (observed) return;
        observed = true;
        confirmed();
      });
    const acknowledged = this.behavior.coordinator?.trackCommand(session, method, params[0]);
    const result = await session.sendWith(method, this.ledger(options, confirm), ...params);
    confirm?.();
    acknowledged?.();
    return result;
  }
  async sendCleanup<M extends Command>(
    session: Session,
    method: M,
    ...params: Params<M>
  ): Promise<Result<M>> {
    this.use(session);
    const acknowledged = this.behavior.coordinator?.trackCommand(session, method, params[0]);
    const result = await this.withinCleanup((options) =>
      session.sendWith(method, this.ledger(options), ...params),
    );
    acknowledged?.();
    return result;
  }
  /** Counts an input command as it is sent; the next planned delay counts from now. */
  private sending(method: string, params: unknown): void {
    const kind = inputKind(method, params);
    if (!kind) return;
    this.report.sent[kind]++;
    if (kind !== 'moves' && kind !== 'wheels') this.report.dispatched++;
    this.paced = performance.now();
  }
  /**
   * Releases remote objects of the action. Objects of a destroyed context or a closed session are
   * already gone; any other failure is a cleanup failure.
   */
  async releaseObjects(
    session: Session,
    objects: { objectId: string } | { objectGroup: string },
  ): Promise<void> {
    try {
      if ('objectId' in objects) await this.sendCleanup(session, 'Runtime.releaseObject', objects);
      else await this.sendCleanup(session, 'Runtime.releaseObjectGroup', objects);
    } catch (error) {
      if (!session.closed && !isObjectGone(error)) this.cleanupFailed(error, session);
    }
  }
  /** Records the request ID so that cleanup can wait for this action's own late replies. */
  private ledger(options: WaitOptions, confirmed?: () => void): LedgerOptions {
    if (!confirmed) return { ...options, [REQUEST_LEDGER]: this.recordRequest };
    return {
      ...options,
      [REQUEST_LEDGER]: (...args) => {
        const recorded = this.recordRequest(...args);
        return {
          ...recorded,
          replied: (late, succeeded) => {
            recorded?.replied?.(late, succeeded);
            if (succeeded) confirmed();
          },
        };
      },
    };
  }
  /**
   * Runs one cleanup wait. While the action is cleaning up, all waits share one budget; before
   * that, and once the action has finished, each wait has a budget of its own.
   */
  private async withinCleanup<T>(wait: (options: WaitOptions) => Promise<T>): Promise<T> {
    const shared =
      this.report.phase === 'cleaning' && !this.finished
        ? (this.cleanupDeadline ??= this.deadline())
        : undefined;
    const deadline = shared ?? this.deadline();
    try {
      return await wait(deadline.options);
    } finally {
      if (!shared) deadline.dispose();
    }
  }
  private deadline(): CleanupDeadline {
    return new CleanupDeadline(
      this.cleanupBudget,
      () => {
        const open = this.dialogOpen();
        if (open) this.noteOnce('dialogWait');
        return open;
      },
      (listener) => {
        const offs = [...this.connections].map((c) => inputCoordinator(c).onPages(listener));
        return () => offs.forEach((off) => off());
      },
    );
  }
  /** Whether a JavaScript dialog is open on a page the action used. */
  private dialogOpen(): boolean {
    for (const [session, page] of this.sessions)
      if (pages(session).dialogOpen(session, page)) return true;
    return false;
  }
  /**
   * Registers how to restore input state that `session` holds; a failed release is a cleanup
   * failure. A composition release concerns only the page's composition.
   */
  release(
    task: () => Promise<void>,
    options: { session?: Session; composition?: boolean } = {},
  ): InputRelease {
    this.step();
    if (options.session) this.use(options.session);
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
            this.cleanupFailed(error, options.session, options.composition);
          }
        })());
      },
    };
    this.releases.push(release);
    return release;
  }
  /**
   * Records a failed cleanup step. Whether it blocks managed input is decided once the action's
   * replies have settled, as a closed page takes its input state with it; after the action has
   * finished, at once.
   */
  private cleanupFailed(error: unknown, session?: Session, composition = false): void {
    const page = session && (this.sessions.get(session) ?? pages(session).pageFor(session));
    const failure: CleanupFailure = { error, page, composition, sessionEnded: !!session?.closed };
    this.failures.push(failure);
    if (!this.finished) this.report.cleanupErrors.push(String(error));
    else this.decide(failure, !!page?.destroyed);
  }
  /**
   * A closed page needs no block. A step that failed only because its page closed, such as a
   * request the page never answered, is no failure: the page's input state ended with it.
   */
  private decide(failure: CleanupFailure, pageClosed: boolean): void {
    const coordinator = this.behavior.coordinator;
    if (pageClosed) {
      if (failure.sessionEnded) failure.dropped = true;
      this.noteOnce('pageClosed');
    } else if (failure.composition) coordinator?.blockComposition(failure.error, failure.page);
    else coordinator?.block(failure.error);
  }
  /**
   * Whether the page closed. Once a session the action used on it has ended, the page's
   * destruction may still be on its way; it is awaited within the cleanup budget.
   */
  private async pageClosed(
    page: InputPage | undefined,
    deadline: CleanupDeadline,
  ): Promise<boolean> {
    if (!page) return false;
    const ended = [...this.sessions].find(([session, owner]) => owner === page && session.closed);
    const connection = ended?.[0].connection;
    if (!page.destroyed && connection && !connection.closed && !deadline.signal.aborted)
      await new Promise<void>((resolve) => {
        const done = () => {
          off();
          deadline.signal.removeEventListener('abort', done);
          resolve();
        };
        const off = inputCoordinator(connection).onPages(() => {
          if (page.destroyed || connection.closed) done();
        });
        deadline.signal.addEventListener('abort', done, { once: true });
      });
    return page.destroyed;
  }
  /**
   * Waits for the action's own replies on the connection, including requests whose caller stopped
   * waiting; unrelated commands keep their own lifecycle. A session that detached never answers;
   * its requests fail like a cleanup step on that session.
   */
  private async drain(connection: Connection, deadline: CleanupDeadline): Promise<void> {
    const ids = this.requests.get(connection);
    try {
      while (ids && connection.outstanding(ids)) {
        await connection.drainRequests(ids, deadline.options);
        for (const id of connection.unanswerable(ids)) {
          const session = [...this.sessions.keys()].find(
            (session) => session.connection === connection && session.id === id,
          );
          this.cleanupFailed(
            session?.closeReason ?? new DisconnectedError(`Session ${id} detached before replying`),
            session,
          );
        }
      }
    } catch (error) {
      this.cleanupFailed(error);
    }
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
        guard: async (checkpoint) => {
          await previous?.guard?.(checkpoint);
          await options.guard?.(checkpoint);
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
      this.inputEnded();
      if (this.acquired) this.behavior.coordinator?.cleaningStarted();
      const deadline = (this.cleanupDeadline ??= this.deadline());
      // Standalone down() transfers ownership only after the complete action succeeds.
      const keep = () => this.report.status === 'completed' && !this.failures.length;
      try {
        if (this.tasks.size) {
          try {
            await bounded(
              Promise.allSettled([...this.tasks]),
              deadline.options,
              'Input task cleanup',
            );
          } catch (error) {
            this.cleanupFailed(error);
          }
        }
        for (const release of [...this.releases].reverse())
          if (!this.retained.has(release) || !keep()) await release.run();
        for (const connection of this.connections) await this.drain(connection, deadline);
        for (const release of [...this.retained].reverse()) {
          if (keep()) release.forget();
          else await release.run();
        }
        // Holds are settled now, which composition blocks depend on.
        for (const failure of this.failures)
          this.decide(failure, await this.pageClosed(failure.page, deadline));
      } finally {
        deadline.dispose();
        this.finished = true;
        if (this.acquired) this.behavior.coordinator?.cleaningFinished();
        for (const dispose of this.disposers) dispose();
        this.recording = false;
      }
      const failures = this.failures.filter((failure) => !failure.dropped);
      this.report.cleanupErrors = failures.map((failure) => String(failure.error));
      this.report.cleanup = failures.length
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
  /** A trace entry that is not an input event. */
  note(type: string): void {
    if (this.report.trace.length < 2000) this.report.trace.push({ type });
  }
  private noteOnce(type: string): void {
    if (this.noted.has(type)) return;
    this.noted.add(type);
    this.note(type);
  }
  record(type: string, fields: { x?: number; y?: number; delay?: number } = {}): void {
    this.report.events++;
    if (this.report.trace.length < 2000) this.report.trace.push({ type, ...fields });
  }
  /** Waits `ms`, as a scope callback asks; the next planned delay counts from its end. */
  async wait(ms: number): Promise<void> {
    timeoutValue(ms, 'wait');
    await this.waitUntil(performance.now() + ms, ms);
  }
  /**
   * Waits for a planned delay. It counts from when the previous input was sent, or from the
   * planned end of the previous delay, so time spent waiting for Chrome's replies counts toward it.
   * Never waits past `limit`, a performance.now() time.
   */
  async pace(ms: number, limit = Infinity): Promise<void> {
    timeoutValue(ms, 'wait');
    await this.waitUntil(Math.min((this.paced ?? performance.now()) + ms, limit), ms);
  }
  /**
   * Starts a planned sequence: its first delay counts from now, not from earlier input, so time the
   * action spent on other work does not make the sequence late.
   */
  startPlan(): void {
    this.paced = performance.now();
  }
  /** Whether a planned delay of `ms` would already have passed. */
  overdue(ms: number): boolean {
    const now = performance.now();
    return (this.paced ?? now) + ms <= now;
  }
  private async waitUntil(due: number, planned: number): Promise<void> {
    await this.check();
    if (planned) {
      this.report.plannedMs += planned;
      if (this.report.trace.length < 2000)
        this.report.trace.push({ type: 'pause', delay: planned });
      const left = Math.min(due, this.end) - performance.now();
      if (left > 0) await this.waitFor(delay(left, this.step().signal));
    }
    this.paced = due;
    await this.check();
  }
}
