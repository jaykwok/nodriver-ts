import { randomUUID } from 'node:crypto';
import type { Session } from '../protocol/connection.ts';
import { ProtocolError, UnsupportedError } from '../errors.ts';

export function isContextGone(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    error.code === -32000 &&
    // Not "Could not find object with given id": a released handle does not mean a new document.
    /Cannot find context with specified id|Execution context was destroyed|Inspected target navigated or closed/.test(
      error.message,
    )
  );
}

// V8 implementation detail, NOT a CDP guarantee. Check it against an official
// isolated-world ID on every discovery, and fail closed on incompatible engines.
export function parseRemoteObjectId(objectId: string | undefined): {
  isolate: string;
  context: number;
} {
  const match = objectId?.match(/^(-?\d+)\.([1-9]\d*)\.([1-9]\d*)$/);
  const context = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(context) || context > 0x7fffffff)
    throw new UnsupportedError(
      'Unsupported Chromium RemoteObjectId format; refusing to enable Runtime as a fallback',
    );
  return { isolate: match[1]!, context };
}

/**
 * The main-world context of the frame that owns `isolatedContext`. Callers bound the wait; the
 * lookup is shared by every caller of one document.
 */
export async function resolveMainContext(
  session: Session,
  isolatedContext: number,
): Promise<number> {
  const objectGroup = randomUUID();
  try {
    // The isolated context belongs to the exact frame, including same-process
    // children. No DOM-tree search, frame-owner access or injected bridge needed.
    const isolated = await session.send('Runtime.evaluate', {
      expression: 'this.document',
      contextId: isolatedContext,
      objectGroup,
      generatePreview: false,
    });
    const source = parseRemoteObjectId(isolated.result.objectId);
    if (source.context !== isolatedContext)
      throw new UnsupportedError('RemoteObjectId context does not match Page.createIsolatedWorld');
    const { node } = await session.send('DOM.describeNode', {
      objectId: isolated.result.objectId!,
    });
    // Chromium ResolveNode uses the node's owning frame MAIN world when the
    // executionContextId is omitted. Always use that frame's CDP session.
    const { object } = await session.send('DOM.resolveNode', {
      backendNodeId: node.backendNodeId,
      objectGroup,
    });
    const main = parseRemoteObjectId(object.objectId);
    if (main.isolate !== source.isolate || main.context === isolatedContext)
      throw new UnsupportedError('DOM.resolveNode did not resolve a distinct main-world context');

    // Verify the inferred context still points at this document before caching
    // it. This read has no user-script side effects and never replays evaluation.
    const probe = await session.send('Runtime.evaluate', {
      expression: 'this.document',
      contextId: main.context,
      objectGroup,
      generatePreview: false,
    });
    if (!probe.result.objectId)
      throw new UnsupportedError('Main-world document could not be verified');
    const verified = await session.send('DOM.describeNode', {
      objectId: probe.result.objectId,
    });
    if (verified.node.backendNodeId !== node.backendNodeId)
      throw new UnsupportedError('Resolved execution context belongs to a different document');
    return main.context;
  } finally {
    // Cleanup must still run after caller cancellation; do not reuse its signal.
    if (!session.closed)
      await session
        .sendWith('Runtime.releaseObjectGroup', { timeout: 1000 }, { objectGroup })
        .catch(() => {});
  }
}
