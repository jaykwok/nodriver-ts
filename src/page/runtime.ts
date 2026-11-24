import type { Protocol } from 'devtools-protocol';
import type { Session } from '../protocol/connection.ts';
import { EvaluationError } from '../errors.ts';

/** @internal Default short timeout for fire-and-forget CDP object/group releases. */
export const RELEASE_TIMEOUT = 1000;

/** @internal Encodes a primitive or special number/bigint value as a CDP `Runtime.CallArgument`. */
export function encodeCallArgument(value: unknown): Protocol.Runtime.CallArgument {
  if (typeof value === 'bigint') return { unserializableValue: `${value}n` };
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0)))
    return { unserializableValue: Object.is(value, -0) ? '-0' : String(value) };
  return { value };
}

/** @internal Decodes a CDP `Runtime.RemoteObject` (including unserializable numbers and BigInt). */
export function decodeRemoteValue(object: Protocol.Runtime.RemoteObject): unknown {
  const value = object.unserializableValue;
  if (value) {
    if (/^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
    if (value === 'NaN') return NaN;
    if (value === 'Infinity') return Infinity;
    if (value === '-Infinity') return -Infinity;
    if (value === '-0') return -0;
  }
  return object.value;
}

/** @internal Formats CDP `Runtime.ExceptionDetails` into a concise error message. */
export function formatExceptionDetails(details: Protocol.Runtime.ExceptionDetails): string {
  const exception = details.exception;
  return (
    exception?.description ??
    (exception && 'value' in exception
      ? `${details.text} ${String(exception.value)}`
      : details.text)
  );
}

/** @internal Best-effort release of one or more CDP RemoteObject handles with a short timeout. */
export function releaseRemoteObjects(
  session: Session,
  objectIds: Iterable<string | undefined>,
  timeout = RELEASE_TIMEOUT,
): void {
  if (session.closed) return;
  const seen = new Set<string>();
  for (const objectId of objectIds) {
    if (!objectId || seen.has(objectId)) continue;
    seen.add(objectId);
    void session.sendWith('Runtime.releaseObject', { timeout }, { objectId }).catch(() => {});
  }
}

/** @internal Best-effort release of a CDP objectGroup with a short timeout. */
export function releaseObjectGroup(
  session: Session,
  objectGroup: string,
  timeout = RELEASE_TIMEOUT,
): Promise<void> {
  if (session.closed) return Promise.resolve();
  return session
    .sendWith('Runtime.releaseObjectGroup', { timeout }, { objectGroup })
    .then(() => undefined)
    .catch(() => {});
}

/**
 * @internal Throws an `EvaluationError` when CDP returns `exceptionDetails`. When `session` is
 * provided, releases both the exception handle and any returned `result.objectId` in the
 * background with a short timeout; otherwise the caller owns object-group cleanup.
 */
export function throwEvaluationException(
  response: {
    result?: Protocol.Runtime.RemoteObject;
    exceptionDetails?: Protocol.Runtime.ExceptionDetails;
  },
  session?: Session,
): void {
  const details = response.exceptionDetails;
  if (!details) return;
  if (session) {
    releaseRemoteObjects(session, [details.exception?.objectId, response.result?.objectId]);
  }
  throw new EvaluationError(formatExceptionDetails(details));
}
