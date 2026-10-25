/** The operation that was active when initialization failed. */
export type StartupStage =
  | 'process-launch'
  | 'profile-preparation'
  | 'port-file'
  | 'endpoint-discovery'
  | 'websocket-connect'
  | 'protocol-handshake'
  | 'target-initialization'
  | 'environment-configuration';

export interface StartupProcessDiagnostics {
  pid?: number;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Last 16,384 characters at most. May contain browser-generated sensitive text. */
  stderr: string;
  stderrStatus: 'captured' | 'discarded' | 'unavailable';
}
export interface StartupDiagnostics {
  stage: StartupStage;
  elapsedMs: number;
  stageElapsedMs: number;
  /** Absent when connecting to an existing browser or before a child exists. */
  process?: Readonly<StartupProcessDiagnostics>;
}
const failures = new WeakMap<object, Readonly<StartupDiagnostics>>();

/** Read a launch/connect failure snapshot, preserving original error classes and abort identity. */
export function getStartupDiagnostics(error: unknown): Readonly<StartupDiagnostics> | undefined {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    ? failures.get(error)
    : undefined;
}

/** @internal One tracker spans process creation through the complete browser handshake. */
export class StartupTracker {
  private readonly recorded = new WeakSet<object>();
  private readonly started = performance.now();
  private stageStarted = this.started;
  private stage: StartupStage = 'process-launch';
  process?: () => StartupProcessDiagnostics;
  private readonly callerSignal?: AbortSignal;
  constructor(callerSignal?: AbortSignal) {
    this.callerSignal = callerSignal;
  }
  enter(stage: StartupStage): void {
    this.stage = stage;
    this.stageStarted = performance.now();
  }
  fail(error: unknown): void {
    if (!(error instanceof Error) || this.recorded.has(error)) return;
    this.recorded.add(error);
    const now = performance.now();
    const process = this.process?.();
    const snapshot = Object.freeze({
      stage: this.stage,
      elapsedMs: now - this.started,
      stageElapsedMs: now - this.stageStarted,
      process: process && Object.freeze(process),
    });
    failures.set(error, snapshot);
    // Caller-owned abort reasons may be shared/frozen. Keep their message and identity intact.
    if (this.callerSignal?.aborted && error === this.callerSignal.reason) return;
    const detail = process
      ? `; PID=${process.pid ?? 'unavailable'}, exited=${process.exited}, exitCode=${process.exitCode}, signal=${process.signal}, stderr=${process.stderrStatus}`
      : '';
    try {
      error.message += ` [startup stage=${snapshot.stage}, elapsed=${snapshot.elapsedMs.toFixed(1)}ms, stageElapsed=${snapshot.stageElapsedMs.toFixed(1)}ms${detail}]${process?.stderr.trim() ? `\n${process.stderr.trim()}` : ''}`;
    } catch {
      /* Frozen errors still have a retrievable snapshot. */
    }
  }
}
