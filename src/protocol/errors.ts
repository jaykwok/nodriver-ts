import {
  DisconnectedError,
  ProtocolError,
  SessionEndedError,
  StaleElementError,
} from '../errors.ts';

/** @internal Brand for synthetic context-loss errors such as cross-process contextId mismatch. */
export const CONTEXT_GONE = Symbol('nodriver.contextGone');

/**
 * Chrome's reply when an execution context is gone or its target navigated/closed.
 * Does not match "Could not find object with given id": a released handle does not mean a new document.
 */
export function isContextGone(error: unknown): boolean {
  if (error && typeof error === 'object' && CONTEXT_GONE in error) return true;
  return (
    error instanceof ProtocolError &&
    error.code === -32000 &&
    /Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed/i.test(
      error.protocolMessage,
    )
  );
}

/** @internal Chrome's reply when an attachment no longer exists (detached or target closed). */
export function isAttachmentGone(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    /session.*(?:not found|not exist)|no session/i.test(error.protocolMessage)
  );
}

/**
 * Returns `true` when `error` indicates a frame was detached or no longer exists: matches
 * `StaleElementError` with `reason === 'frame-detached'`, Chrome's `No frame for/with given id`
 * `ProtocolError`, or an error whose `cause` chain matches either.
 */
export function isFrameGone(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = error; cur && typeof cur === 'object' && !seen.has(cur);) {
    seen.add(cur);
    if (cur instanceof StaleElementError && cur.reason === 'frame-detached') return true;
    if (cur instanceof ProtocolError && /No frame (?:for|with) given id/i.test(cur.protocolMessage))
      return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/** @internal Chrome's reply when a DOM node or backendNodeId no longer exists. */
export function isNodeGone(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    /No node (?:with given id )?found|Could not find node/i.test(error.protocolMessage)
  );
}

/** @internal Chrome's reply when a RemoteObject handle or its execution context is gone. */
export function isObjectGone(error: unknown): boolean {
  return (
    isContextGone(error) ||
    (error instanceof ProtocolError &&
      /Could not find object with given id/i.test(error.protocolMessage))
  );
}

/** @internal Chrome's reply when a RemoteObject argument does not belong to the receiver's world. */
export function isWorldMismatch(error: unknown): boolean {
  return error instanceof ProtocolError && /same JavaScript world/i.test(error.protocolMessage);
}

/** @internal Chrome's reply or local state indicating a target is already closed/gone. */
export function isTargetGone(error: unknown): boolean {
  return (
    error instanceof DisconnectedError ||
    error instanceof SessionEndedError ||
    (error instanceof ProtocolError && /No target with given id/i.test(error.protocolMessage))
  );
}

/** @internal Chrome's reply when a node has no CSS layout box (e.g. `display: none`). */
export function isNoLayoutObject(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    /Node does not have a layout object/i.test(error.protocolMessage)
  );
}

/** @internal Chrome's reply when an intercepted Fetch request is already gone or Fetch was disabled. */
export function isRequestGone(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    /Invalid InterceptionId|Fetch domain is not enabled/i.test(error.protocolMessage)
  );
}
