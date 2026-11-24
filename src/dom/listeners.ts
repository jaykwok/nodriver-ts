import type { Protocol } from 'devtools-protocol';
import { ON_LATE_REPLY, type LedgerOptions, type Session } from '../protocol/connection.ts';
import { StaleElementError } from '../errors.ts';
import { isNodeGone } from '../protocol/errors.ts';
import { budget, type WaitOptions } from '../utils.ts';
import { createObjectGroup, type IsolatedWorld } from '../page/isolated-world.ts';
import { releaseObjectGroup, releaseRemoteObjects } from '../page/runtime.ts';

/** Target node for `getNodeEventListeners()`: either a resolved `objectId` or a `backendNodeId`. */
export type NodeEventListenerTarget =
  | { readonly objectId: Protocol.Runtime.RemoteObjectId }
  | { readonly backendNodeId: Protocol.DOM.BackendNodeId };

export interface GetNodeEventListenersOptions extends WaitOptions {
  /**
   * Maximum subtree depth to inspect (`0` or `1` for the node itself, `-1` for the entire
   * subtree). Forwarded directly to `DOMDebugger.getEventListeners`; omitted when `undefined`.
   */
  depth?: number;
  /** Traverse iframes and shadow roots when inspecting a subtree. Omitted when `undefined`. */
  pierce?: boolean;
  /**
   * Optional isolated world to inspect listeners registered inside **that** isolated world.
   *
   * Omit both `world` and `executionContextId` (the default) to inspect page main-world listeners:
   * Chromium scopes `DOMDebugger.getEventListeners` to the world of the resolved `objectId`, so
   * `DOM.resolveNode({ backendNodeId })` without `executionContextId` returns a read-only
   * main-world handle (with zero `*.enable` and zero main-world JS execution), whereas an
   * isolated-world handle returns only listeners registered in that isolated world.
   * Ignored when `objectId` is passed directly.
   */
  world?: IsolatedWorld;
  /**
   * Explicit `executionContextId` passed to `DOM.resolveNode` when inspecting a specific execution
   * context instead of the default main world. Mutually exclusive with `world`.
   */
  executionContextId?: number;
  /**
   * How returned `handler` / `originalHandler` remote handles are released on direct `{ objectId }`
   * targets (defaults to `'each'` for backwards compatibility; pass `'none'` when the supplied
   * `objectId` belongs to a caller-managed `ObjectGroupScope` so the outer group releases
   * everything in O(1)).
   *
   * Ignored on `{ backendNodeId }` targets, which always use O(1) bulk release via their internal
   * temporary `ObjectGroupScope` (`Runtime.releaseObjectGroup`) and late-reply group cleanup.
   */
  releaseHandles?: 'each' | 'none';
  /**
   * Optional event-type allowlist (exact string match, e.g. `['click', 'mousedown', 'mouseup']`).
   * Filters listeners while mapping results; remote handle cleanup still covers all returned
   * listener handles.
   */
  types?: readonly string[];
}

/** Read-only metadata extracted from `DOMDebugger.EventListener` (all remote handles released). */
export interface NodeEventListener {
  readonly type: string;
  readonly useCapture: boolean;
  readonly passive: boolean;
  readonly once: boolean;
  readonly scriptId: Protocol.Runtime.ScriptId;
  readonly lineNumber: number;
  readonly columnNumber: number;
  readonly backendNodeId?: Protocol.DOM.BackendNodeId;
  readonly handlerDescription?: string;
  readonly originalHandlerDescription?: string;
}

function releaseListenerHandles(
  response: Protocol.DOMDebugger.GetEventListenersResponse | undefined,
  session: Session,
): void {
  if (!response) return;
  const ids: Array<string | undefined> = [];
  for (const listener of response.listeners ?? []) {
    ids.push(listener.handler?.objectId, listener.originalHandler?.objectId);
  }
  releaseRemoteObjects(session, ids);
}

function mapListeners(
  response: Protocol.DOMDebugger.GetEventListenersResponse,
  types?: ReadonlySet<string>,
): NodeEventListener[] {
  const out: NodeEventListener[] = [];
  for (const listener of response.listeners ?? []) {
    if (types && !types.has(listener.type)) continue;
    out.push({
      type: listener.type,
      useCapture: listener.useCapture,
      passive: listener.passive,
      once: listener.once,
      scriptId: listener.scriptId,
      lineNumber: listener.lineNumber,
      columnNumber: listener.columnNumber,
      ...(listener.backendNodeId !== undefined ? { backendNodeId: listener.backendNodeId } : {}),
      ...(listener.handler?.description !== undefined
        ? { handlerDescription: listener.handler.description }
        : {}),
      ...(listener.originalHandler?.description !== undefined
        ? { originalHandlerDescription: listener.originalHandler.description }
        : {}),
    });
  }
  return out;
}

async function queryByObjectId(
  session: Session,
  objectId: Protocol.Runtime.RemoteObjectId,
  params: { depth?: number; pierce?: boolean },
  wait: WaitOptions,
  releaseMode: 'each' | 'group' | 'none',
  group?: { readonly name: string; readonly released: boolean },
  types?: ReadonlySet<string>,
): Promise<NodeEventListener[]> {
  const options: LedgerOptions = {
    ...wait,
    ...(releaseMode === 'each'
      ? {
          [ON_LATE_REPLY]: (reply: unknown) =>
            releaseListenerHandles(
              reply as Protocol.DOMDebugger.GetEventListenersResponse | undefined,
              session,
            ),
        }
      : releaseMode === 'group' && group
        ? {
            [ON_LATE_REPLY]: () => {
              // On an out-of-order peer where group release already completed before this late
              // reply arrived, issue a single O(1) group release rather than N releaseObject calls.
              if (group.released && !session.closed) void releaseObjectGroup(session, group.name);
            },
          }
        : {}),
  };
  const response = await session.sendWith('DOMDebugger.getEventListeners', options, {
    objectId,
    ...(params.depth !== undefined ? { depth: params.depth } : {}),
    ...(params.pierce !== undefined ? { pierce: params.pierce } : {}),
  });
  if (releaseMode === 'each') releaseListenerHandles(response, session);
  return mapListeners(response, types);
}

/**
 * Queries DOM event listeners via `DOMDebugger.getEventListeners` without enabling `DOM`,
 * `Runtime`, `Page`, or `Debugger`, releasing returned remote handles cleanly (in O(1) via the
 * temporary `ObjectGroupScope` on `{ backendNodeId }` targets, or per-handle by default on direct
 * `{ objectId }` targets).
 *
 * Accepts either an already-resolved `objectId` or a `backendNodeId`. For `{ backendNodeId }`,
 * omitting both `world` and `executionContextId` (the default) calls
 * `DOM.resolveNode({ backendNodeId, objectGroup })` with no `executionContextId` to obtain a
 * read-only main-world handle and return page main-world listeners (Chromium scopes
 * `DOMDebugger.getEventListeners` to the handle's world: an isolated-world handle only returns
 * listeners registered in that isolated world).
 */
export async function getNodeEventListeners(
  session: Session,
  target: NodeEventListenerTarget,
  options: GetNodeEventListenersOptions = {},
): Promise<NodeEventListener[]> {
  if (options.depth !== undefined && (!Number.isInteger(options.depth) || options.depth < -1))
    throw new RangeError('depth must be an integer >= -1');
  if (
    options.releaseHandles !== undefined &&
    options.releaseHandles !== 'each' &&
    options.releaseHandles !== 'none'
  )
    throw new TypeError('releaseHandles must be "each" or "none"');
  let typeFilter: Set<string> | undefined;
  if (options.types !== undefined) {
    if (!Array.isArray(options.types)) throw new TypeError('types must be an array of strings');
    typeFilter = new Set<string>();
    for (const t of options.types) {
      if (typeof t !== 'string' || !t)
        throw new TypeError('types entries must be non-empty strings');
      typeFilter.add(t);
    }
  }
  if (
    'objectId' in target &&
    'backendNodeId' in target &&
    target.objectId !== undefined &&
    target.backendNodeId !== undefined
  )
    throw new TypeError('Specify either objectId or backendNodeId, not both');
  if (options.world && options.executionContextId !== undefined)
    throw new TypeError('Specify either world or executionContextId, not both');
  const queryParams = { depth: options.depth, pierce: options.pierce };
  const step = budget(options, 'getNodeEventListeners');

  if ('objectId' in target) {
    if (!target.objectId) throw new TypeError('objectId must be a non-empty string');
    const mode = options.releaseHandles ?? 'each';
    return queryByObjectId(
      session,
      target.objectId,
      queryParams,
      step(),
      mode,
      undefined,
      typeFilter,
    );
  }

  const backendNodeId = target.backendNodeId;
  if (!Number.isInteger(backendNodeId) || backendNodeId <= 0)
    throw new RangeError('backendNodeId must be a positive integer');

  const resolveAndQuery = async (
    group: { readonly name: string; readonly releasing: boolean; readonly released: boolean },
    executionContextId: number | undefined,
    nextStep: () => WaitOptions,
  ): Promise<NodeEventListener[]> => {
    let object: Protocol.Runtime.RemoteObject;
    try {
      const resolveOptions: LedgerOptions = {
        ...nextStep(),
        [ON_LATE_REPLY]: (reply) => {
          const lateId = (reply as Protocol.DOM.ResolveNodeResponse | undefined)?.object?.objectId;
          if (lateId && !session.closed) void releaseObjectGroup(session, group.name);
        },
      };
      ({ object } = await session.sendWith('DOM.resolveNode', resolveOptions, {
        backendNodeId,
        ...(executionContextId !== undefined ? { executionContextId } : {}),
        objectGroup: group.name,
      }));
    } catch (error) {
      if (isNodeGone(error))
        throw new StaleElementError('Node no longer exists', {
          cause: error,
          reason: 'node-detached',
        });
      throw error;
    }
    if (!object.objectId)
      throw new StaleElementError('Node no longer exists', { reason: 'node-detached' });
    if (group.releasing) {
      if (!session.closed) void releaseObjectGroup(session, group.name);
      throw new StaleElementError('Node object group was released before query completed', {
        reason: 'disposed',
      });
    }
    return queryByObjectId(
      session,
      object.objectId,
      queryParams,
      nextStep(),
      'group',
      group,
      typeFilter,
    );
  };

  if (options.world) {
    if (options.world.session !== session)
      throw new TypeError('options.world must belong to the same session');
    return options.world.withObjectGroup(
      (group, contextId, worldStep) => resolveAndQuery(group, contextId, worldStep),
      step(),
    );
  }

  const group = createObjectGroup(session);
  try {
    return await resolveAndQuery(group, options.executionContextId, step);
  } finally {
    // Queue group release immediately without extending the caller's deadline; background cleanup
    // suppresses protocol errors and `connection.drain()` waits only for wire settlement.
    void group.release().catch(() => {});
  }
}
