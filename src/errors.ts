import type { ClearSiteDataResult } from './browser/context.ts';
export class NodriverError extends Error {
  override name = 'NodriverError';
}
/** A person is operating this lease's browser; other tools wait until browser_handoff_wait ends. */
export class HandoffActiveError extends NodriverError {
  override name = 'HandoffActiveError';
}
export class TimeoutError extends NodriverError {
  override name = 'TimeoutError';
}
export class DisconnectedError extends NodriverError {
  override name = 'DisconnectedError';
}
export type EndReason =
  'detach-requested' | 'detached' | 'target-destroyed' | 'target-crashed' | 'disconnected';
/** Single-session termination reasons (excluding whole-connection disconnect). */
export type SessionEndReason = Exclude<EndReason, 'disconnected'>;
/**
 * A single target or session ended while the browser CDP connection remained distinct from it.
 * Connection-level disconnects throw `DisconnectedError` instead.
 */
export class SessionEndedError extends NodriverError {
  override name = 'SessionEndedError';
  readonly reason: SessionEndReason;
  readonly targetId: string;
  readonly sessionId?: string;
  constructor(
    reason: SessionEndReason,
    targetId: string,
    options?: ErrorOptions & { sessionId?: string; detail?: string },
  ) {
    const label = targetId || options?.sessionId || 'unknown';
    const detail = options?.detail ? `: ${options.detail}` : '';
    super(`Target session ended: ${reason} (${label})${detail}`, options);
    this.reason = reason;
    this.targetId = targetId;
    this.sessionId = options?.sessionId;
  }
}
/** A profile has a live controller/browser owner; connect to it or close it before launching. */
export class ProfileInUseError extends NodriverError {
  override name = 'ProfileInUseError';
  readonly profile: string;
  constructor(profile: string, message: string) {
    super(message);
    this.profile = profile;
  }
}
export type StaleElementReason =
  'node-detached' | 'frame-detached' | 'context-gone' | 'world-mismatch' | 'disposed';
export interface StaleElementErrorOptions extends ErrorOptions {
  reason?: StaleElementReason;
}
export class StaleElementError extends NodriverError {
  override name = 'StaleElementError';
  readonly reason?: StaleElementReason;
  constructor(message?: string, options?: StaleElementErrorOptions) {
    super(message, options);
    this.reason = options?.reason;
  }
}
export class UnsupportedError extends NodriverError {
  override name = 'UnsupportedError';
}
export class ActionabilityError extends NodriverError {
  override name = 'ActionabilityError';
}
export class ProtocolError extends NodriverError {
  override name = 'ProtocolError';
  readonly method: string;
  readonly code: number;
  readonly data?: string;
  /** Chrome's error message, without the method, data and session. */
  readonly protocolMessage: string;
  /** The attachment the command was sent to; absent for the browser session. */
  readonly sessionId?: string;
  /** Target type of that session (`browser`, `page`, `iframe`, `worker` ...), when known. */
  readonly targetType?: string;
  constructor(
    method: string,
    code: number,
    message: string,
    data?: string,
    target?: { sessionId?: string; targetType?: string },
  ) {
    const session = target
      ? ` [${target.targetType ? `${target.targetType} ` : ''}session${target.sessionId ? ` ${target.sessionId}` : ''}]`
      : '';
    super(`${method}: ${message}${data ? ` (${data})` : ''}${session}`);
    this.method = method;
    this.code = code;
    this.data = data;
    this.protocolMessage = message;
    this.sessionId = target?.sessionId;
    this.targetType = target?.targetType;
  }
}
export class EvaluationError extends NodriverError {
  override name = 'EvaluationError';
}
/**
 * clearSiteData() stopped after it started changing pages or data: by timeout, signal, a failed
 * step, or a cookie that was set again. `result` lists what was done; a step in progress when it
 * stopped is not listed and may still take effect.
 */
export class ClearSiteDataError extends NodriverError {
  override name = 'ClearSiteDataError';
  readonly result: ClearSiteDataResult;
  constructor(message: string, result: ClearSiteDataResult, options?: ErrorOptions) {
    super(message, options);
    this.result = result;
  }
}
/** The caller stopped waiting for a page fetch, by timeout or signal; see `aborted`. */
export class FetchCancelledError extends NodriverError {
  override name = 'FetchCancelledError';
  /**
   * True when the page's request was aborted, or ended with its document. False when it could
   * not be reached or had already finished, so the server may have received it.
   */
  readonly aborted: boolean;
  constructor(message: string, aborted: boolean, options?: ErrorOptions) {
    super(message, options);
    this.aborted = aborted;
  }
}
