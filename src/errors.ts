export class NodriverError extends Error {
  override name = 'NodriverError';
}
export class TimeoutError extends NodriverError {
  override name = 'TimeoutError';
}
export class DisconnectedError extends NodriverError {
  override name = 'DisconnectedError';
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
export class StaleElementError extends NodriverError {
  override name = 'StaleElementError';
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
