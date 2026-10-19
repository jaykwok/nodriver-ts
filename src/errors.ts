export class NodriverError extends Error {
  override name = 'NodriverError';
}
export class TimeoutError extends NodriverError {
  override name = 'TimeoutError';
}
export class DisconnectedError extends NodriverError {
  override name = 'DisconnectedError';
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
  constructor(method: string, code: number, message: string, data?: string) {
    super(`${method}: ${message}${data ? ` (${data})` : ''}`);
    this.method = method;
    this.code = code;
    this.data = data;
  }
}
export class EvaluationError extends NodriverError {
  override name = 'EvaluationError';
}
