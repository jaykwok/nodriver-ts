import { randomUUID } from 'node:crypto';
import type { Session } from '../protocol/connection.ts';
import { ProtocolError, UnsupportedError } from '../errors.ts';
import type { WaitOptions } from '../utils.ts';

export function isContextGone(error: unknown): boolean {
  return (
    error instanceof ProtocolError &&
    error.code === -32000 &&
    /Cannot find context with specified id|Execution context was destroyed|Cannot find object with given id|Inspected target navigated or closed/.test(
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

export async function resolveMainContext(
  session: Session,
  isolatedContext: number,
  options: WaitOptions,
): Promise<number> {
  const objectGroup = randomUUID();
  try {
    // The isolated context belongs to the exact frame, including same-process
    // children. No DOM-tree search, frame-owner access or injected bridge needed.
    const isolated = await session.sendWith('Runtime.evaluate', options, {
      expression: 'this.document',
      contextId: isolatedContext,
      objectGroup,
      generatePreview: false,
    });
    const source = parseRemoteObjectId(isolated.result.objectId);
    if (source.context !== isolatedContext)
      throw new UnsupportedError('RemoteObjectId context does not match Page.createIsolatedWorld');
    const { node } = await session.sendWith('DOM.describeNode', options, {
      objectId: isolated.result.objectId!,
    });
    // Chromium ResolveNode uses the node's owning frame MAIN world when the
    // executionContextId is omitted. Always use that frame's CDP session.
    const { object } = await session.sendWith('DOM.resolveNode', options, {
      backendNodeId: node.backendNodeId,
      objectGroup,
    });
    const main = parseRemoteObjectId(object.objectId);
    if (main.isolate !== source.isolate || main.context === isolatedContext)
      throw new UnsupportedError('DOM.resolveNode did not resolve a distinct main-world context');

    // Verify the inferred context still points at this document before caching
    // it. This read has no user-script side effects and never replays evaluation.
    const probe = await session.sendWith('Runtime.evaluate', options, {
      expression: 'this.document',
      contextId: main.context,
      objectGroup,
      generatePreview: false,
    });
    if (!probe.result.objectId)
      throw new UnsupportedError('Main-world document could not be verified');
    const verified = await session.sendWith('DOM.describeNode', options, {
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
