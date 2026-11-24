import { abortReason, bounded, positiveInt, timeoutValue, type WaitOptions } from '../utils.ts';
import { NodriverError, TimeoutError } from '../errors.ts';
import type { Connection, EventParams, Session } from '../protocol/connection.ts';

export type PresentationLeaseLifecycle =
  'idle' | 'starting' | 'active' | 'stopping' | 'closed' | 'disconnected';

export type PresentationLeaseReason =
  | 'closed'
  | 'duration-limit'
  | 'frame-limit'
  | 'byte-limit'
  | 'ack-limit'
  | 'ack-timeout'
  | 'start-failed'
  | 'disconnected'
  | 'aborted';

/** Page.startScreencast parameters. Chrome's defaults apply to omitted fields. */
export interface PresentationScreencastOptions {
  format?: 'jpeg' | 'png';
  /** JPEG quality from 0 to 100. */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  /** Send every n-th frame. */
  everyNthFrame?: number;
}

export interface PresentationLeaseOptions {
  /** Page.startScreencast parameters, such as a small JPEG to save bandwidth. */
  screencast?: PresentationScreencastOptions;
  /**
   * When true, omit default duration, frame and byte caps so the lease stays active until
   * `close()`, `signal` abort, disconnect or an explicit cap is reached. Explicit finite limits
   * still apply.
   */
  untilClosed?: boolean;
  /**
   * Total time from start() until the lease stops. Pass `Infinity` or `null` for no duration
   * limit. Defaults to 5000 ms (or unbounded when `untilClosed` is true).
   */
  maxDuration?: number | null;
  /**
   * Maximum number of frames offered for acknowledgement. Pass `Infinity` or `null` for no frame
   * limit. Defaults to 16 (or unbounded when `untilClosed` is true).
   */
  maxFrames?: number | null;
  /**
   * Maximum base64-decoded frame bytes offered by this lease (counted when each frame is accepted
   * for acknowledgement). Pass `Infinity` or `null` for no byte limit. Defaults to 4 MiB (or
   * unbounded when `untilClosed` is true).
   */
  maxBytes?: number | null;
  /** Maximum concurrent Page.screencastFrameAck requests. Defaults to 4. */
  maxInFlightAcks?: number;
  /** Deadline for Page.startScreencast. Defaults to 2000 ms. */
  startTimeout?: number;
  /** Per-ack deadline. Defaults to 1000 ms. */
  ackTimeout?: number;
  /** Independent stop and ACK cleanup budget. Defaults to 2000 ms. */
  stopTimeout?: number;
  signal?: AbortSignal;
  /**
   * Receives each frame. The frame is acknowledged once this settles, also when it throws, so
   * Chrome sends no more frames than the receiver takes; handle errors inside it.
   */
  deliver?: (frame: EventParams<'Page.screencastFrame'>) => void | Promise<void>;
}

export interface ResolvedPresentationLeaseOptions {
  screencast?: PresentationScreencastOptions;
  untilClosed: boolean;
  maxDuration: number;
  maxFrames: number;
  maxBytes: number;
  maxInFlightAcks: number;
  startTimeout: number;
  ackTimeout: number;
  stopTimeout: number;
  signal?: AbortSignal;
  deliver?: (frame: EventParams<'Page.screencastFrame'>) => void | Promise<void>;
}

export interface PresentationReport {
  state: 'active' | 'stopped' | 'timed-out' | 'failed' | 'disconnected';
  cleanup: 'pending' | 'completed' | 'timed-out' | 'failed' | 'disconnected';
  reason?: PresentationLeaseReason;
  attempted: boolean;
  active: boolean;
  closed: boolean;
  frames: number;
  acknowledgedFrames: number;
  droppedFrames: number;
  encodedBytes: number;
  inFlightAcks: number;
  ackErrors: number;
  cleanupErrors: string[];
  error?: string;
}

const DEFAULTS = {
  maxDuration: 5000,
  maxFrames: 16,
  maxBytes: 4 * 1024 * 1024,
  maxInFlightAcks: 4,
  startTimeout: 2000,
  ackTimeout: 1000,
  stopTimeout: 2000,
} as const;

const owners = new WeakMap<Connection, Map<string, PresentationLease>>();

function claim(session: Session, lease: PresentationLease): void {
  const id = session.id!;
  let sessions = owners.get(session.connection);
  if (!sessions) owners.set(session.connection, (sessions = new Map()));
  const owner = sessions.get(id);
  if (owner && owner !== lease)
    throw new NodriverError('Presentation session already has an active lease');
  sessions.set(id, lease);
}

function release(session: Session, lease: PresentationLease): void {
  const sessions = owners.get(session.connection);
  if (sessions?.get(session.id!) === lease) {
    sessions.delete(session.id!);
    if (!sessions.size) owners.delete(session.connection);
  }
}

function limit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
  return value;
}

function durationLimit(value: number | null | undefined, fallback: number): number {
  if (value === null || value === Infinity) return Infinity;
  if (value === undefined) return fallback;
  return timeoutValue(value, 'maxDuration');
}

function countLimit(name: string, value: number | null | undefined, fallback: number): number {
  if (value === null || value === Infinity) return Infinity;
  if (value === undefined) return fallback;
  return limit(name, value);
}

function positiveLimit(name: string, value: number): number {
  return positiveInt(value, name);
}

function screencastOptions(
  options: PresentationScreencastOptions | undefined,
): PresentationScreencastOptions | undefined {
  if (!options) return undefined;
  const { format, quality, maxWidth, maxHeight, everyNthFrame, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new TypeError(`Unknown screencast option ${unknown[0]}`);
  if (format !== undefined && format !== 'jpeg' && format !== 'png')
    throw new TypeError('screencast.format must be jpeg or png');
  if (quality !== undefined && limit('screencast.quality', quality) > 100)
    throw new RangeError('screencast.quality must be at most 100');
  if (maxWidth !== undefined) positiveLimit('screencast.maxWidth', maxWidth);
  if (maxHeight !== undefined) positiveLimit('screencast.maxHeight', maxHeight);
  if (everyNthFrame !== undefined) positiveLimit('screencast.everyNthFrame', everyNthFrame);
  return Object.fromEntries(
    Object.entries({ format, quality, maxWidth, maxHeight, everyNthFrame }).filter(
      ([, value]) => value !== undefined,
    ),
  );
}

/**
 * A bounded Page screencast used to keep a background target observable for a short operation.
 * The lease never activates a target, enables Runtime, retries input, or drains the connection.
 */
export class PresentationLease {
  readonly session: Session;
  readonly options: ResolvedPresentationLeaseOptions;
  readonly report: PresentationReport = {
    state: 'stopped',
    cleanup: 'pending',
    attempted: false,
    active: false,
    closed: false,
    frames: 0,
    acknowledgedFrames: 0,
    droppedFrames: 0,
    encodedBytes: 0,
    inFlightAcks: 0,
    ackErrors: 0,
    cleanupErrors: [],
  };

  private lifecycle: PresentationLeaseLifecycle = 'idle';
  private startPromise?: Promise<PresentationReport>;
  private startTask?: Promise<unknown>;
  private closePromise?: Promise<PresentationReport>;
  private requestedReason?: PresentationLeaseReason;
  private listenerOff?: () => void;
  private disconnectOff?: () => void;
  private abortOff?: () => void;
  private durationTimer?: ReturnType<typeof setTimeout>;
  private readonly durationController = new AbortController();
  private readonly closeController = new AbortController();
  private startAt = 0;
  private startAttempted = false;
  private ownsSession = false;
  private disconnected = false;
  private readonly inFlight = new Set<Promise<void>>();

  constructor(session: Session, options: PresentationLeaseOptions = {}) {
    if (!session.id) throw new TypeError('PresentationLease requires a target session');
    this.session = session;
    const untilClosed = options.untilClosed ?? false;
    this.options = {
      screencast: screencastOptions(options.screencast),
      untilClosed,
      maxDuration: durationLimit(
        options.maxDuration,
        untilClosed ? Infinity : DEFAULTS.maxDuration,
      ),
      maxFrames: countLimit(
        'maxFrames',
        options.maxFrames,
        untilClosed ? Infinity : DEFAULTS.maxFrames,
      ),
      maxBytes: countLimit(
        'maxBytes',
        options.maxBytes,
        untilClosed ? Infinity : DEFAULTS.maxBytes,
      ),
      maxInFlightAcks: positiveLimit(
        'maxInFlightAcks',
        options.maxInFlightAcks ?? DEFAULTS.maxInFlightAcks,
      ),
      startTimeout: timeoutValue(options.startTimeout ?? DEFAULTS.startTimeout, 'startTimeout'),
      ackTimeout: timeoutValue(options.ackTimeout ?? DEFAULTS.ackTimeout, 'ackTimeout'),
      stopTimeout: timeoutValue(options.stopTimeout ?? DEFAULTS.stopTimeout, 'stopTimeout'),
      signal: options.signal,
      deliver: options.deliver,
    };
  }

  get state(): PresentationLeaseLifecycle {
    return this.lifecycle;
  }

  start(): Promise<PresentationReport> {
    if (this.startPromise) return this.startPromise;
    const promise = this.startInternal();
    this.startPromise = promise.catch((error: unknown) => {
      // An ownership conflict does not consume the lease. Allow the caller to retry after the
      // current owner closes; all other failures transition this lease to a terminal state.
      if (this.lifecycle === 'idle') this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  close(): Promise<PresentationReport> {
    if (!this.closePromise) {
      this.requestClose('closed');
    }
    return this.closePromise!;
  }

  private requestClose(reason: PresentationLeaseReason): void {
    this.requestedReason ??= reason;
    if (this.lifecycle === 'starting')
      this.closeController.abort(new NodriverError('Presentation lease is stopping'));
    void this.finish(reason);
  }

  private async startInternal(): Promise<PresentationReport> {
    if (this.lifecycle !== 'idle')
      throw new NodriverError(`Presentation lease cannot start from ${this.lifecycle}`);
    if (this.options.signal?.aborted) {
      const error = abortReason(this.options.signal);
      this.requestedReason = 'aborted';
      await this.finish('aborted');
      throw error;
    }
    if (this.session.closed) {
      const error = this.session.closedError();
      this.report.error = String(error);
      this.requestedReason = 'disconnected';
      await this.finish('disconnected');
      throw error;
    }

    claim(this.session, this);
    this.ownsSession = true;
    this.lifecycle = 'starting';
    this.startAt = performance.now();
    try {
      this.abortOff = this.options.signal
        ? (() => {
            const abort = () => {
              this.requestedReason ??= 'aborted';
              void this.finish('aborted');
            };
            this.options.signal!.addEventListener('abort', abort, { once: true });
            return () => this.options.signal?.removeEventListener('abort', abort);
          })()
        : undefined;
      this.disconnectOff = this.session.disconnected.on(() => {
        this.disconnected = true;
        this.requestedReason ??= 'disconnected';
        void this.finish('disconnected');
      });
      this.listenerOff = this.session.on('Page.screencastFrame', (event) => this.onFrame(event));
      if (Number.isFinite(this.options.maxDuration)) {
        this.durationTimer = setTimeout(() => {
          this.requestedReason ??= 'duration-limit';
          this.durationController.abort(new TimeoutError('Presentation lease duration exceeded'));
          this.requestClose('duration-limit');
        }, this.options.maxDuration);
      }

      this.startAttempted = true;
      this.report.attempted = true;
      const remaining = this.remainingDuration();
      const startTimeout = Math.min(this.options.startTimeout, remaining);
      const signals = [
        this.options.signal,
        this.durationController.signal,
        this.closeController.signal,
      ].filter((signal): signal is AbortSignal => !!signal);
      const startOptions: WaitOptions = {
        timeout: startTimeout,
        signal: AbortSignal.any(signals),
      };
      this.startTask = this.session.sendWith(
        'Page.startScreencast',
        startOptions,
        this.options.screencast,
      );
      await this.startTask;
      if (this.requestedReason) {
        await this.finish(this.requestedReason);
        return this.snapshot();
      }
      this.lifecycle = 'active';
      this.report.state = 'active';
      this.report.active = true;
      return this.snapshot();
    } catch (error) {
      this.report.error = String(error);
      const reason =
        this.disconnected || this.session.closed
          ? 'disconnected'
          : this.options.signal?.aborted
            ? 'aborted'
            : (this.requestedReason ?? 'start-failed');
      this.requestedReason ??= reason;
      await this.finish(reason);
      throw error;
    }
  }

  private onFrame(event: EventParams<'Page.screencastFrame'>): void {
    if (this.lifecycle !== 'active' && this.lifecycle !== 'starting') {
      this.report.droppedFrames++;
      return;
    }
    const bytes = Buffer.byteLength(event.data, 'base64');
    if (this.report.frames >= this.options.maxFrames) {
      this.report.droppedFrames++;
      this.requestClose('frame-limit');
      return;
    }
    if (this.report.encodedBytes + bytes > this.options.maxBytes) {
      this.report.droppedFrames++;
      this.requestClose('byte-limit');
      return;
    }
    if (this.inFlight.size >= this.options.maxInFlightAcks) {
      this.report.droppedFrames++;
      this.requestClose('ack-limit');
      return;
    }

    this.report.frames++;
    this.report.encodedBytes += bytes;
    const acknowledge = () =>
      this.session.sendWith(
        'Page.screencastFrameAck',
        { timeout: this.options.ackTimeout },
        { sessionId: event.sessionId },
      );
    const deliver = this.options.deliver;
    const ack = (
      deliver ? (async () => deliver(event))().then(acknowledge, acknowledge) : acknowledge()
    ).then(
      () => {
        if (!this.report.closed) this.report.acknowledgedFrames++;
      },
      (error: unknown) => {
        if (!this.report.closed) {
          this.report.ackErrors++;
          if (error instanceof TimeoutError) this.requestClose('ack-timeout');
        }
      },
    );
    this.inFlight.add(ack);
    this.report.inFlightAcks = this.inFlight.size;
    void ack.then(
      () => {
        this.inFlight.delete(ack);
        if (!this.report.closed) this.report.inFlightAcks = this.inFlight.size;
      },
      () => {
        this.inFlight.delete(ack);
        if (!this.report.closed) this.report.inFlightAcks = this.inFlight.size;
      },
    );
  }

  private finish(reason: PresentationLeaseReason): Promise<PresentationReport> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishInternal(reason);
    return this.closePromise;
  }

  private async finishInternal(reason: PresentationLeaseReason): Promise<PresentationReport> {
    this.requestedReason ??= reason;
    if (this.lifecycle === 'closed' || this.lifecycle === 'disconnected') return this.snapshot();
    this.lifecycle = 'stopping';
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = undefined;
    this.abortOff?.();
    this.abortOff = undefined;
    this.listenerOff?.();
    this.listenerOff = undefined;
    this.disconnectOff?.();
    this.disconnectOff = undefined;

    // Wait for a start attempt to settle before issuing stop. This preserves command order when
    // close races with the start response, while the start deadline keeps the wait bounded.
    await this.startTask?.catch(() => {});
    const deadline = performance.now() + this.options.stopTimeout;
    const stopRemaining = () => Math.max(0, Math.ceil(deadline - performance.now()));
    let stopFailed = false;
    if (this.startAttempted && !this.session.closed && !this.disconnected) {
      try {
        await this.session.sendWith('Page.stopScreencast', {
          timeout: stopRemaining(),
        });
      } catch (error) {
        this.report.cleanupErrors.push(String(error));
        this.report.error ??= String(error);
        stopFailed = true;
      }
    }
    const pending = [...this.inFlight];
    if (pending.length) {
      try {
        await bounded(
          Promise.allSettled(pending),
          {
            timeout: stopRemaining(),
          },
          'Presentation ACK cleanup',
        );
      } catch (error) {
        this.report.cleanupErrors.push(String(error));
        this.report.cleanup = 'timed-out';
      }
    }

    this.report.inFlightAcks = this.inFlight.size;
    this.report.active = false;
    this.report.closed = true;
    this.lifecycle = this.disconnected || this.session.closed ? 'disconnected' : 'closed';
    if (this.disconnected || this.session.closed) this.report.cleanup = 'disconnected';
    else if (this.report.cleanup === 'pending')
      this.report.cleanup = this.report.cleanupErrors.length ? 'failed' : 'completed';
    this.report.reason =
      this.disconnected || this.session.closed ? 'disconnected' : this.requestedReason;
    // A failed stop is a state of its own; `reason` keeps why the lease ended.
    this.report.state =
      this.disconnected || this.session.closed
        ? 'disconnected'
        : stopFailed || this.report.reason === 'start-failed'
          ? 'failed'
          : this.report.reason === 'duration-limit' ||
              this.report.reason === 'ack-timeout' ||
              this.report.reason === 'frame-limit' ||
              this.report.reason === 'byte-limit' ||
              this.report.reason === 'ack-limit'
            ? 'timed-out'
            : 'stopped';
    if (this.ownsSession) {
      release(this.session, this);
      this.ownsSession = false;
    }
    return this.snapshot();
  }

  private remainingDuration(): number {
    if (!Number.isFinite(this.options.maxDuration)) return Infinity;
    return Math.max(0, this.options.maxDuration - (performance.now() - this.startAt));
  }

  private snapshot(): PresentationReport {
    return {
      ...this.report,
      cleanupErrors: [...this.report.cleanupErrors],
    };
  }
}

export function createPresentationLease(
  session: Session,
  options: PresentationLeaseOptions = {},
): PresentationLease {
  return new PresentationLease(session, options);
}
