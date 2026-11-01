import { abortReason, bounded, timeoutValue, type WaitOptions } from '../utils.ts';
import { DisconnectedError, NodriverError, TimeoutError } from '../errors.ts';
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
  | 'stop-failed'
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
  /** Total time from start() until the lease stops. Defaults to 5000 ms. */
  maxDuration?: number;
  /** Maximum number of frames offered for acknowledgement. Defaults to 16. */
  maxFrames?: number;
  /** Maximum base64-decoded frame bytes acknowledged by this lease. Defaults to 4 MiB. */
  maxBytes?: number;
  /** Maximum concurrent Page.screencastFrameAck requests. Defaults to 4. */
  maxInFlightAcks?: number;
  /** Deadline for Page.startScreencast. Defaults to 2000 ms. */
  startTimeout?: number;
  /** Per-ack deadline. Defaults to 1000 ms. */
  ackTimeout?: number;
  /** Independent stop and ACK cleanup budget. Defaults to 2000 ms. */
  stopTimeout?: number;
  signal?: AbortSignal;
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

function positiveLimit(name: string, value: number): number {
  limit(name, value);
  if (value < 1) throw new RangeError(`${name} must be at least 1`);
  return value;
}

function screencastOptions(
  options: PresentationScreencastOptions | undefined,
): PresentationScreencastOptions | undefined {
  if (!options) return undefined;
  const { format, quality, maxWidth, maxHeight, everyNthFrame, ...rest } = options;
  const unknown = Object.keys(rest);
  if (unknown.length) throw new TypeError(`Unknown screencast option ${unknown[0]}`);
  if (format !== undefined && format !== 'jpeg' && format !== 'png')
    throw new RangeError('screencast.format must be jpeg or png');
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
  readonly options: Required<Omit<PresentationLeaseOptions, 'signal' | 'screencast'>> &
    Pick<PresentationLeaseOptions, 'signal' | 'screencast'>;
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
    this.options = {
      screencast: screencastOptions(options.screencast),
      maxDuration: timeoutValue(options.maxDuration ?? DEFAULTS.maxDuration, 'maxDuration'),
      maxFrames: limit('maxFrames', options.maxFrames ?? DEFAULTS.maxFrames),
      maxBytes: limit('maxBytes', options.maxBytes ?? DEFAULTS.maxBytes),
      maxInFlightAcks: positiveLimit(
        'maxInFlightAcks',
        options.maxInFlightAcks ?? DEFAULTS.maxInFlightAcks,
      ),
      startTimeout: timeoutValue(options.startTimeout ?? DEFAULTS.startTimeout, 'startTimeout'),
      ackTimeout: timeoutValue(options.ackTimeout ?? DEFAULTS.ackTimeout, 'ackTimeout'),
      stopTimeout: timeoutValue(options.stopTimeout ?? DEFAULTS.stopTimeout, 'stopTimeout'),
      signal: options.signal,
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
      const error = new DisconnectedError('Presentation session is closed', {
        cause: this.session.closeReason,
      });
      this.report.error = String(this.session.closeReason ?? error);
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
      this.durationTimer = setTimeout(() => {
        this.requestedReason ??= 'duration-limit';
        this.durationController.abort(new TimeoutError('Presentation lease duration exceeded'));
        this.requestClose('duration-limit');
      }, this.options.maxDuration);

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
    const ack = this.session
      .sendWith(
        'Page.screencastFrameAck',
        { timeout: this.options.ackTimeout },
        { sessionId: event.sessionId },
      )
      .then(
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
    if (this.startAttempted && !this.session.closed && !this.disconnected) {
      try {
        await this.session.sendWith('Page.stopScreencast', {
          timeout: Math.max(0, deadline - performance.now()),
        });
      } catch (error) {
        this.report.cleanupErrors.push(String(error));
        this.report.error ??= String(error);
        if (!this.session.closed && !this.disconnected) this.requestedReason = 'stop-failed';
      }
    }
    const pending = [...this.inFlight];
    if (pending.length) {
      try {
        await bounded(
          Promise.allSettled(pending),
          {
            timeout: Math.max(0, deadline - performance.now()),
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
    this.report.state =
      this.disconnected || this.session.closed
        ? 'disconnected'
        : this.report.reason === 'duration-limit' ||
            this.report.reason === 'ack-timeout' ||
            this.report.reason === 'frame-limit' ||
            this.report.reason === 'byte-limit' ||
            this.report.reason === 'ack-limit'
          ? 'timed-out'
          : this.report.reason === 'start-failed' || this.report.reason === 'stop-failed'
            ? 'failed'
            : 'stopped';
    if (this.ownsSession) {
      release(this.session, this);
      this.ownsSession = false;
    }
    return this.snapshot();
  }

  private remainingDuration(): number {
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
