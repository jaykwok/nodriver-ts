import { test } from 'node:test';
import inspector from 'node:inspector/promises';
import vm from 'node:vm';
import { expect } from '../fixtures/expect.ts';
import { Connection, TargetSession } from '../../src/protocol/connection.ts';
import { Frame, type FrameManager } from '../../src/page/frames.ts';
import { parseRemoteObjectId, resolveMainContext } from '../../src/page/execution-context.ts';
import {
  createIsolatedWorld,
  DisconnectedError,
  evaluateIsolated,
  EvaluationError,
  invalidateIsolatedWorlds,
  isContextGone,
  ProtocolError,
  SessionEndedError,
  StaleElementError,
  TimeoutError,
  UnsupportedError,
  type IsolatedWorldEvent,
} from '../../src/index.ts';
import type { Transport } from '../../src/transport/transport.ts';

class ContextTransport implements Transport {
  onmessage?: (message: string) => void;
  onclose?: (error: Error) => void;
  messages: Array<{ method: string; params: Record<string, unknown> }> = [];
  objectId = '-123.7.2';
  backendNodeId = 42;
  contextLost = false;
  onRelease?: () => void;
  send(message: string) {
    const m = JSON.parse(message);
    this.messages.push(m);
    if (this.contextLost && m.params?.expression === 'sideEffect()') {
      queueMicrotask(() =>
        this.onmessage?.(
          JSON.stringify({
            id: m.id,
            sessionId: m.sessionId,
            error: { code: -32000, message: 'Cannot find context with specified id' },
          }),
        ),
      );
      return;
    }
    let result: unknown;
    switch (m.method) {
      case 'Page.createIsolatedWorld':
        result = { executionContextId: 8 };
        break;
      case 'DOM.describeNode':
        result = {
          node: { backendNodeId: m.params.objectId === '-123.7.3' ? this.backendNodeId : 42 },
        };
        break;
      case 'DOM.resolveNode':
        result = { object: { type: 'object', objectId: this.objectId } };
        break;
      case 'Runtime.evaluate':
        result = {
          result:
            m.params.expression === 'this.document'
              ? { type: 'object', objectId: m.params.contextId === 8 ? '-123.8.1' : '-123.7.3' }
              : { type: 'number', value: 5 },
        };
        break;
      case 'Runtime.releaseObjectGroup':
        this.onRelease?.();
        result = {};
        break;
      default:
        throw new Error(`Unexpected command ${m.method}`);
    }
    queueMicrotask(() =>
      this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result })),
    );
  }
  close() {}
}

test('incompatible object IDs fail explicitly instead of guessing a context', () => {
  expect(parseRemoteObjectId('-123.7.2')).toEqual({ isolate: '-123', context: 7 });
  for (const id of [
    undefined,
    '',
    '7',
    '{}',
    'a.7.2',
    '1.0.1',
    '1.-1.2',
    '1.2147483648.2',
    '1.1.0',
    '1.2.3.extra',
  ])
    expect(() => parseRemoteObjectId(id)).toThrow(UnsupportedError);
});
test('wrong context/document fails closed and always releases temporary objects', async () => {
  for (const objectId of ['changed-format', '-123.8.2', '999.7.2', '-123.7.2']) {
    const transport = new ContextTransport();
    transport.objectId = objectId;
    transport.backendNodeId = 99;
    const connection = new Connection(transport);
    try {
      await expect(resolveMainContext(connection.session('frame'), 8)).rejects.toBeInstanceOf(
        UnsupportedError,
      );
      expect(transport.messages.at(-1)?.method).toBe('Runtime.releaseObjectGroup');
      expect(transport.messages.some((m) => m.method === 'Runtime.enable')).toBe(false);
      expect(connection.pendingCount).toBe(0);
    } finally {
      await connection.close();
    }
  }
});
test('navigation during discovery cannot run user script; fresh document can recover', async () => {
  const transport = new ContextTransport();
  const connection = new Connection(transport);
  const frame = new Frame(
    { worldName: 'test' } as unknown as FrameManager,
    'frame',
    connection.session('page'),
  );
  transport.onRelease = () => frame.invalidate();
  try {
    await expect(frame.evaluate('sideEffect()')).rejects.toBeInstanceOf(StaleElementError);
    expect(transport.messages.some((m) => m.params?.expression === 'sideEffect()')).toBe(false);
    transport.onRelease = undefined;
    expect(await frame.evaluate('sideEffect()')).toBe(5);
    expect(transport.messages.filter((m) => m.params?.expression === 'sideEffect()').length).toBe(
      1,
    );
  } finally {
    await connection.close();
  }
});

test('lost contexts clear caches for the next call without replaying user code', async () => {
  const transport = new ContextTransport();
  const connection = new Connection(transport);
  const frame = new Frame(
    { worldName: 'test' } as unknown as FrameManager,
    'frame',
    connection.session('page'),
  );
  try {
    await frame.evaluate('sideEffect()');
    transport.contextLost = true;
    await expect(frame.evaluate('sideEffect()')).rejects.toThrow('Cannot find context');
    expect(transport.messages.filter((m) => m.params?.expression === 'sideEffect()').length).toBe(
      2,
    );
    transport.contextLost = false;
    expect(await frame.evaluate('sideEffect()')).toBe(5);
    expect(transport.messages.filter((m) => m.method === 'Page.createIsolatedWorld').length).toBe(
      2,
    );
  } finally {
    await connection.close();
  }
});

test('isContextGone identifies Chrome context-loss errors and rejects unrelated errors', () => {
  for (const message of [
    'Cannot find context with specified id',
    'Execution context was destroyed.',
    'Inspected target navigated or closed',
  ]) {
    expect(isContextGone(new ProtocolError('Runtime.evaluate', -32000, message))).toBe(true);
  }
  expect(
    isContextGone(
      new ProtocolError('Runtime.callFunctionOn', -32000, 'Could not find object with given id'),
    ),
  ).toBe(false);
  expect(
    isContextGone(
      new ProtocolError('Runtime.evaluate', -32602, 'Cannot find context with specified id'),
    ),
  ).toBe(false);
  expect(isContextGone(new Error('Cannot find context with specified id'))).toBe(false);
});

test('IsolatedWorld and evaluateIsolated bind to globalThis handles, survive cross-process contextId reuse, never enable domains or fall back to main world', async () => {
  let isolate = 1;
  let nextContext = 10;
  const mainContext = 1;
  let staleContexts = new Set<number>();
  type WorldState = {
    isolate: number;
    contextId: number;
    frameId: string;
    worldName: string;
    guards: Map<string, string>;
  };
  const liveObjects = new Map<string, WorldState>();
  const namedWorlds = new Map<string, number>();
  const docObjects = new Map<string, { isolate: number; contextId: number; frameId: string }>();
  const releasedGroups: string[] = [];
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const transport: Transport = {
    send(raw: string) {
      const m = JSON.parse(raw) as {
        id: number;
        sessionId?: string;
        method: string;
        params?: Record<string, unknown>;
      };
      sent.push({ method: m.method, params: m.params ?? {} });
      queueMicrotask(() => {
        if (m.method === 'Target.attachToTarget') {
          this.onmessage?.(JSON.stringify({ id: m.id, result: { sessionId: 'sess-1' } }));
          return;
        }
        if (m.method === 'Runtime.releaseObjectGroup') {
          releasedGroups.push(String(m.params?.objectGroup ?? ''));
          this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: {} }));
          return;
        }
        if (m.method === 'Page.createIsolatedWorld') {
          const worldName = String(m.params?.worldName ?? '');
          const frameId = String(m.params?.frameId ?? '');
          const nameKey = `${isolate}\0${frameId}\0${worldName}`;
          let executionContextId = namedWorlds.get(nameKey);
          if (executionContextId === undefined || staleContexts.has(executionContextId)) {
            executionContextId = ++nextContext;
            namedWorlds.set(nameKey, executionContextId);
          }
          const objectId = `${isolate}.${executionContextId}.1`;
          if (!liveObjects.has(objectId)) {
            liveObjects.set(objectId, {
              isolate,
              contextId: executionContextId,
              frameId,
              worldName,
              guards: new Map(),
            });
          }
          this.onmessage?.(
            JSON.stringify({ id: m.id, sessionId: m.sessionId, result: { executionContextId } }),
          );
          return;
        }
        if (m.method === 'DOM.describeNode') {
          const doc = docObjects.get(String(m.params?.objectId ?? ''));
          if (!doc || doc.isolate !== isolate) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'No node with given id found' },
              }),
            );
            return;
          }
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { node: { backendNodeId: 42, frameId: doc.frameId } },
            }),
          );
          return;
        }
        if (m.method === 'DOM.resolveNode') {
          const resolvedCtx = (m.params?.executionContextId as number | undefined) ?? mainContext;
          const resolvedId = `${isolate}.${resolvedCtx}.${m.params?.executionContextId ? 4 : 3}`;
          if (m.params?.executionContextId) {
            const owner = liveObjects.get(`${isolate}.${resolvedCtx}.1`);
            if (owner)
              docObjects.set(resolvedId, {
                isolate: owner.isolate,
                contextId: owner.contextId,
                frameId: owner.frameId,
              });
          }
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { object: { type: 'object', objectId: resolvedId } },
            }),
          );
          return;
        }
        if (m.method === 'Runtime.evaluate') {
          const ctx = m.params?.contextId as number | undefined;
          // Must NEVER fall back to main world (omitting contextId).
          expect(typeof ctx).toBe('number');
          if (m.params?.expression === 'globalThis') {
            const objectId = `${isolate}.${ctx}.1`;
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId } },
              }),
            );
            return;
          }
          if (staleContexts.has(ctx!)) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Cannot find context with specified id' },
              }),
            );
            return;
          }
          const expr = String(m.params?.expression ?? '');
          const guardMatch = expr.match(
            /getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value==="([^"]+)"[\s\S]*throw "([^"]+)"/,
          );
          if (guardMatch) {
            const [, key, token, mismatch] = guardMatch;
            const owner = liveObjects.get(`${isolate}.${ctx}.1`);
            if (!owner || owner.guards.get(key!) !== token) {
              this.onmessage?.(
                JSON.stringify({
                  id: m.id,
                  sessionId: m.sessionId,
                  result: {
                    result: { type: 'string', value: mismatch },
                    exceptionDetails: {
                      exceptionId: 1,
                      text: 'Uncaught',
                      lineNumber: 0,
                      columnNumber: 0,
                      exception: { type: 'string', value: mismatch },
                    },
                  },
                }),
              );
              return;
            }
          }
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { result: { type: 'string', value: `iso${isolate}:ctx${ctx}` } },
            }),
          );
          return;
        }
        if (m.method === 'Runtime.callFunctionOn') {
          const objectId = m.params?.objectId as string | undefined;
          // Bound to the isolated world's globalThis or document handle, never bare numeric executionContextId.
          expect(typeof objectId).toBe('string');
          const fnDecl = String(m.params?.functionDeclaration ?? '');
          const args = m.params?.arguments as
            Array<{ value?: unknown; objectId?: string }> | undefined;
          if (fnDecl === 'function(other){return this === other}') {
            const docA = docObjects.get(objectId!);
            const docB = docObjects.get(String(args?.[0]?.objectId ?? ''));
            const match =
              !!docA &&
              !!docB &&
              docA.isolate === isolate &&
              docA.isolate === docB.isolate &&
              docA.contextId === docB.contextId &&
              docA.frameId === docB.frameId;
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'boolean', value: match } },
              }),
            );
            return;
          }
          const owner = liveObjects.get(objectId!);
          if (!owner || owner.isolate !== isolate || staleContexts.has(owner.contextId)) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Cannot find context with specified id' },
              }),
            );
            return;
          }
          const arg0 = args?.[0]?.value;
          if (fnDecl === 'function(){return this.document}') {
            const docId = `${owner.isolate}.${owner.contextId}.2`;
            docObjects.set(docId, {
              isolate: owner.isolate,
              contextId: owner.contextId,
              frameId: owner.frameId,
            });
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId: docId } },
              }),
            );
            return;
          }
          if (fnDecl.includes('Object.defineProperty')) {
            const key = String(args?.[0]?.value);
            let token = owner.guards.get(key);
            if (!token) {
              token = String(args?.[1]?.value);
              owner.guards.set(key, token);
            }
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'string', value: token } },
              }),
            );
            return;
          }
          if (fnDecl === 'function(){return 1}') {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'number', value: 1 } },
              }),
            );
            return;
          }
          if (arg0 === 'throwError()') {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: {
                  result: { type: 'object' },
                  exceptionDetails: {
                    exceptionId: 1,
                    text: 'Uncaught',
                    lineNumber: 0,
                    columnNumber: 0,
                    exception: { type: 'object', description: 'Error: boom' },
                  },
                },
              }),
            );
            return;
          }
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: {
                result:
                  arg0 === 'bigint'
                    ? { type: 'bigint', unserializableValue: '42n' }
                    : {
                        type: 'string',
                        value: `iso${owner.isolate}:ctx${owner.contextId}:${owner.worldName}`,
                      },
              },
            }),
          );
          return;
        }
        throw new Error(`Unexpected CDP command: ${m.method}`);
      });
    },
    close() {},
  };
  const connection = new Connection(transport);
  try {
    const session = await connection.attachSession('target-1');
    expect(session).toBeInstanceOf(TargetSession);

    // Repeated calls share cached handle for (session, frameId, worldName) with 1 RTT per call.
    expect(await evaluateIsolated<string>(session, 'ctx', undefined, { worldName: 'w1' })).toBe(
      'iso1:ctx11:w1',
    );
    expect(await evaluateIsolated(session, (n: number) => `${n}`, 1, { worldName: 'w1' })).toBe(
      'iso1:ctx11:w1',
    );
    expect(await evaluateIsolated<bigint>(session, 'bigint', undefined, { worldName: 'w1' })).toBe(
      42n,
    );
    expect(await evaluateIsolated<string>(session, 'ctx', undefined, { worldName: 'w2' })).toBe(
      'iso1:ctx12:w2',
    );
    expect(
      await evaluateIsolated<string>(session, 'ctx', undefined, {
        frameId: 'subframe-1',
        worldName: 'w1',
      }),
    ).toBe('iso1:ctx13:w1');

    // Cross-process navigation: new isolate reuses numeric contextId 11 (e.g. for its MAIN world)!
    // Old globalThis handle (1.11.1) MUST fail in isolate 2 and trigger rebuild instead of hitting wrong context.
    isolate = 2;
    nextContext = 10; // Next created context in isolate 2 will reuse numeric ID 11!
    const [r1, r2] = await Promise.all([
      evaluateIsolated<string>(session, 'ctx', undefined, { worldName: 'w1' }),
      evaluateIsolated<string>(session, 'ctx', undefined, { worldName: 'w1' }),
    ]);
    expect(r1).toBe('iso2:ctx11:w1');
    expect(r2).toBe('iso2:ctx11:w1');

    // Cross-process navigation ALSO caught by executionTimeout, context(), and run()!
    isolate = 3;
    nextContext = 10;
    expect(
      await evaluateIsolated<string>(session, 'ctx', undefined, {
        worldName: 'w1',
        executionTimeout: 500,
      }),
    ).toBe('iso3:ctx11');
    isolate = 4;
    nextContext = 10;
    const world = createIsolatedWorld(session, { worldName: 'w-cross' });
    expect(await world.context()).toBe(11);
    isolate = 5;
    nextContext = 10;
    // world.context() verifies handle before returning cached numeric ID -> detects isolate change and rebuilds.
    const createsBefore = sent.filter((m) => m.method === 'Page.createIsolatedWorld').length;
    expect(await world.context()).toBe(11);
    expect(sent.filter((m) => m.method === 'Page.createIsolatedWorld').length).toBe(
      createsBefore + 2,
    );

    // If the rebuilt context is ALSO gone, stops after max 1 retry (no infinite loop).
    staleContexts = new Set([11, 12, 13]);
    await expect(world.evaluate('ctx')).rejects.toBeInstanceOf(ProtocolError);
    staleContexts.clear();

    // retryOnContextGone: false clears cache for the NEXT call without replaying the failing one.
    const noReplay = createIsolatedWorld(session, { worldName: 'w-noreplay' });
    const firstVal = await noReplay.evaluate<string>('ctx');
    const firstCtx = Number(firstVal.match(/ctx(\d+)/)![1]);
    staleContexts.add(firstCtx);
    await expect(
      noReplay.evaluate('ctx', undefined, { retryOnContextGone: false }),
    ).rejects.toBeInstanceOf(ProtocolError);
    // Simulate navigation: the old named world no longer exists in the new document.
    namedWorlds.delete(`${isolate}\0target-1\0w-noreplay`);
    staleContexts.clear();
    const nextVal = await noReplay.evaluate<string>('ctx');
    expect(nextVal).not.toBe(firstVal);

    // EvaluationError is never retried.
    await expect(noReplay.evaluate('throwError()')).rejects.toBeInstanceOf(EvaluationError);

    // world.run() bounds custom async callbacks with total timeout and AbortSignal!
    const started = performance.now();
    await expect(
      noReplay.run(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          return 'late';
        },
        { timeout: 25 },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(performance.now() - started).toBeLessThan(120);

    const controller = new AbortController();
    const abortReason = new Error('stop run');
    setTimeout(() => controller.abort(abortReason), 15);
    await expect(
      noReplay.run(() => new Promise(() => {}), { signal: controller.signal, timeout: 5000 }),
    ).rejects.toBe(abortReason);

    // Never sent Runtime.enable or Page.enable, and old objectGroups were released.
    expect(sent.some((m) => m.method.endsWith('.enable'))).toBe(false);
    expect(releasedGroups.length).toBeGreaterThan(0);

    // After single-session detach, rejects with SessionEndedError (not DisconnectedError).
    connection.detach(session.id!);
    const endedErr = await noReplay.evaluate('ctx').catch((e) => e);
    expect(endedErr).toBeInstanceOf(SessionEndedError);
    expect(endedErr instanceof DisconnectedError).toBe(false);
  } finally {
    await connection.close();
  }
});

test('IsolatedWorld catches mid-binding main-world and named-world collisions, executionTimeout swap, concurrent cold-start retries, abort-before-run-callback, pre-aborted signal, and initial globalThis context loss', async () => {
  let isolate = 1;
  let mainContext = 1;
  let nextContext = 1;
  let swapAfterCreate: false | 'main' | 'other-world' = false;
  let swapBeforeTimeoutEval = false;
  let failFirstGlobalThis = false;
  let onVerifyProbe: (() => void) | undefined;
  let userCodeInWrongWorld = false;
  let nextHandleSeq = 10;
  type WorldState = {
    isolate: number;
    contextId: number;
    frameId: string;
    worldName: string;
    isMain: boolean;
    guards: Map<string, string>;
  };
  const namedWorlds = new Map<string, number>();
  const worlds = new Map<string, WorldState>();
  const handles = new Map<string, WorldState>();
  const groupHandles = new Map<string, Set<string>>();
  const releasedHandles = new Set<string>();
  const docs = new Map<string, WorldState>();
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const registerHandle = (objectId: string, state: WorldState, group?: string) => {
    handles.set(objectId, state);
    if (group) {
      let set = groupHandles.get(group);
      if (!set) groupHandles.set(group, (set = new Set()));
      set.add(objectId);
    }
  };
  const transport: Transport = {
    send(raw: string) {
      const m = JSON.parse(raw) as {
        id: number;
        sessionId?: string;
        method: string;
        params?: Record<string, unknown>;
      };
      sent.push({ method: m.method, params: m.params ?? {} });
      queueMicrotask(() => {
        if (m.method === 'Target.attachToTarget') {
          this.onmessage?.(JSON.stringify({ id: m.id, result: { sessionId: 'sess-race' } }));
          return;
        }
        if (m.method === 'Runtime.releaseObjectGroup') {
          const group = String(m.params?.objectGroup ?? '');
          const ids = groupHandles.get(group);
          if (ids) {
            for (const id of ids) {
              releasedHandles.add(id);
              handles.delete(id);
              docs.delete(id);
            }
            groupHandles.delete(group);
          }
          this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: {} }));
          return;
        }
        if (m.method === 'Page.createIsolatedWorld') {
          const frameId = String(m.params?.frameId ?? '');
          const worldName = String(m.params?.worldName ?? '');
          const nameKey = `${isolate}\0${frameId}\0${worldName}`;
          let executionContextId = namedWorlds.get(nameKey);
          if (executionContextId === undefined) {
            executionContextId = ++nextContext;
            namedWorlds.set(nameKey, executionContextId);
            worlds.set(`${isolate}.${executionContextId}`, {
              isolate,
              contextId: executionContextId,
              frameId,
              worldName,
              isMain: false,
              guards: new Map(),
            });
          }
          if (swapAfterCreate) {
            const mode = swapAfterCreate;
            swapAfterCreate = false;
            isolate++;
            if (mode === 'main') {
              // New renderer's MAIN world reuses executionContextId!
              mainContext = executionContextId;
              nextContext = executionContextId;
              worlds.set(`${isolate}.${executionContextId}`, {
                isolate,
                contextId: executionContextId,
                frameId,
                worldName: '',
                isMain: true,
                guards: new Map(),
              });
            } else {
              // New renderer's OTHER named isolated world reuses executionContextId!
              mainContext = 1;
              nextContext = executionContextId;
              namedWorlds.set(`${isolate}\0${frameId}\0other-world`, executionContextId);
              worlds.set(`${isolate}.${executionContextId}`, {
                isolate,
                contextId: executionContextId,
                frameId,
                worldName: 'other-world',
                isMain: false,
                guards: new Map(),
              });
            }
          }
          this.onmessage?.(
            JSON.stringify({ id: m.id, sessionId: m.sessionId, result: { executionContextId } }),
          );
          return;
        }
        if (m.method === 'Runtime.evaluate') {
          const ctx = m.params?.contextId as number;
          const expr = String(m.params?.expression ?? '');
          const group = m.params?.objectGroup as string | undefined;
          if (expr === 'globalThis') {
            if (failFirstGlobalThis) {
              failFirstGlobalThis = false;
              this.onmessage?.(
                JSON.stringify({
                  id: m.id,
                  sessionId: m.sessionId,
                  error: { code: -32000, message: 'Cannot find context with specified id' },
                }),
              );
              return;
            }
            const state = worlds.get(`${isolate}.${ctx}`)!;
            const objectId = `${isolate}.${ctx}.${++nextHandleSeq}`;
            registerHandle(objectId, state, group);
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId } },
              }),
            );
            return;
          }
          if (swapBeforeTimeoutEval) {
            swapBeforeTimeoutEval = false;
            // Renderer swaps right between ensureGuard and Runtime.evaluate; new MAIN world reuses ctx!
            isolate++;
            mainContext = ctx;
            nextContext = ctx;
            worlds.set(`${isolate}.${ctx}`, {
              isolate,
              contextId: ctx,
              frameId: 'target-race',
              worldName: '',
              isMain: true,
              guards: new Map(),
            });
          }
          const target = worlds.get(`${isolate}.${ctx}`);
          const guardMatch = expr.match(
            /getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value==="([^"]+)"[\s\S]*throw "([^"]+)"/,
          );
          expect(guardMatch).toBeTruthy();
          const [, key, token, mismatch] = guardMatch!;
          if (!target || target.guards.get(key!) !== token) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: {
                  result: { type: 'string', value: mismatch },
                  exceptionDetails: {
                    exceptionId: 1,
                    text: 'Uncaught',
                    lineNumber: 0,
                    columnNumber: 0,
                    exception: { type: 'string', value: mismatch },
                  },
                },
              }),
            );
            return;
          }
          if (target.isMain || target.worldName === 'other-world') userCodeInWrongWorld = true;
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: {
                result: {
                  type: 'string',
                  value: `safe:iso${isolate}:ctx${ctx}:${target.worldName}`,
                },
              },
            }),
          );
          return;
        }
        if (m.method === 'Runtime.callFunctionOn') {
          const objectId = String(m.params?.objectId ?? '');
          const fnDecl = String(m.params?.functionDeclaration ?? '');
          const args = m.params?.arguments as
            Array<{ value?: unknown; objectId?: string }> | undefined;
          const group = m.params?.objectGroup as string | undefined;
          if (releasedHandles.has(objectId)) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Could not find object with given id' },
              }),
            );
            return;
          }
          if (fnDecl === 'function(other){return this === other}') {
            const docA = docs.get(objectId);
            const docB = docs.get(String(args?.[0]?.objectId ?? ''));
            const match =
              !!docA &&
              !!docB &&
              docA.isolate === isolate &&
              docA.isolate === docB.isolate &&
              docA.contextId === docB.contextId &&
              docA.frameId === docB.frameId;
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'boolean', value: match } },
              }),
            );
            return;
          }
          const owner = handles.get(objectId);
          if (!owner || owner.isolate !== isolate) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Cannot find context with specified id' },
              }),
            );
            return;
          }
          if (fnDecl === 'function(){return this.document}') {
            const docId = `${owner.isolate}.${owner.contextId}.${++nextHandleSeq}`;
            docs.set(docId, owner);
            registerHandle(docId, owner, group);
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId: docId } },
              }),
            );
            return;
          }
          if (fnDecl.includes('Object.defineProperty')) {
            const key = String(args?.[0]?.value);
            let token = owner.guards.get(key);
            if (!token) {
              token = String(args?.[1]?.value);
              owner.guards.set(key, token);
            }
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'string', value: token } },
              }),
            );
            return;
          }
          if (fnDecl === 'function(){return 1}') {
            onVerifyProbe?.();
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'number', value: 1 } },
              }),
            );
            return;
          }
          if (owner.isMain || owner.worldName === 'other-world') userCodeInWrongWorld = true;
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: {
                result: {
                  type: 'string',
                  value: `safe:iso${owner.isolate}:ctx${owner.contextId}:${owner.worldName}`,
                },
              },
            }),
          );
          return;
        }
        if (m.method === 'DOM.describeNode') {
          const doc = docs.get(String(m.params?.objectId ?? ''));
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { node: { backendNodeId: 77, frameId: doc!.frameId } },
            }),
          );
          return;
        }
        if (m.method === 'DOM.resolveNode') {
          const group = m.params?.objectGroup as string | undefined;
          const ctx = (m.params?.executionContextId as number | undefined) ?? mainContext;
          const resolvedId = `${isolate}.${ctx}.${++nextHandleSeq}`;
          const state = worlds.get(`${isolate}.${ctx}`);
          if (state) {
            docs.set(resolvedId, state);
            registerHandle(resolvedId, state, group);
          }
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { object: { type: 'object', objectId: resolvedId } },
            }),
          );
          return;
        }
        throw new Error(`Unexpected CDP command: ${m.method}`);
      });
    },
    close() {},
  };
  const connection = new Connection(transport);
  try {
    const session = await connection.attachSession('target-race');
    expect(() => createIsolatedWorld(session, { worldName: '' })).toThrow(TypeError);
    const world = createIsolatedWorld(session, { worldName: 'w-race' });

    // 1. Pre-aborted signal on cold cache sends ZERO CDP commands.
    const sentBeforeAbort = sent.length;
    const reason = new Error('pre-aborted');
    await expect(
      world.evaluate('1', undefined, { signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    await expect(world.run(async () => 'x', { signal: AbortSignal.abort(reason) })).rejects.toBe(
      reason,
    );
    await expect(world.context({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(sent.length).toBe(sentBeforeAbort);

    // 2. Window A (main world): renderer swap between Page.createIsolatedWorld and globalThis
    //    reusing numeric ID for the new MAIN world is caught and rebuilt once into 'w-race'.
    swapAfterCreate = 'main';
    const resA = await world.evaluate<string>('1');
    expect(resA).toBe('safe:iso2:ctx3:w-race');
    expect(userCodeInWrongWorld).toBe(false);

    // 3. Window B: renderer swap between ensureGuard and Runtime.evaluate({ executionTimeout })
    //    reusing numeric ID for the new MAIN world triggers guard mismatch BEFORE user code runs.
    swapBeforeTimeoutEval = true;
    const resB = await world.evaluate<string>('1', undefined, { executionTimeout: 500 });
    expect(resB).toBe('safe:iso3:ctx4:w-race');
    expect(userCodeInWrongWorld).toBe(false);

    // 2b. Window A (other named isolated world): renderer swap reusing numeric ID for 'other-world'
    //     passes main-world check, is caught by worldName confirmation, and rebuilds into 'w-named'.
    const named = createIsolatedWorld(session, { worldName: 'w-named' });
    swapAfterCreate = 'other-world';
    const resNamed = await named.evaluate<string>('1');
    expect(resNamed).toBe('safe:iso4:ctx6:w-named');
    expect(userCodeInWrongWorld).toBe(false);

    // 4. Context loss during initial globalThis binding shares the single rebuild retry cleanly
    //    even across CONCURRENT cold-start callers (never releasing the rebuilt handle!).
    const concurrent = createIsolatedWorld(session, { worldName: 'w-concurrent' });
    failFirstGlobalThis = true;
    const globalEvaluatesBefore = sent.filter(
      (m) => m.method === 'Runtime.evaluate' && m.params.expression === 'globalThis',
    ).length;
    const [c1, c2] = await Promise.all([
      concurrent.evaluate<string>('1'),
      concurrent.evaluate<string>('1'),
    ]);
    expect(c1).toBe('safe:iso4:ctx7:w-concurrent');
    expect(c2).toBe('safe:iso4:ctx7:w-concurrent');
    // Exactly 2 globalThis bindings total (1 failed + 1 shared rebuild), NEVER 3!
    expect(
      sent.filter((m) => m.method === 'Runtime.evaluate' && m.params.expression === 'globalThis')
        .length,
    ).toBe(globalEvaluatesBefore + 2);

    // Same single rebuild retry on initial globalThis loss for concurrent world.run() / world.context().
    const freshRun = createIsolatedWorld(session, { worldName: 'w-run-retry' });
    failFirstGlobalThis = true;
    const [runA, runB] = await Promise.all([freshRun.run(async (ctx) => ctx), freshRun.context()]);
    expect(runA).toBe(8);
    expect(runB).toBe(8);

    // 5. Abort firing as cached handle verification completes must NEVER invoke world.run() callback.
    const abortCtrl = new AbortController();
    const runAbort = new Error('abort during verify');
    let callbackRuns = 0;
    onVerifyProbe = () => {
      onVerifyProbe = undefined;
      abortCtrl.abort(runAbort);
    };
    const runErr = await freshRun
      .run(
        async () => {
          callbackRuns++;
          return 'should-not-run';
        },
        { signal: abortCtrl.signal },
      )
      .catch((e) => e);
    expect(runErr).toBe(runAbort);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callbackRuns).toBe(0);

    // 6. run() counts synchronous callback prologue time against the original total timeout.
    const syncStarted = performance.now();
    await expect(
      freshRun.run(
        async () => {
          const until = performance.now() + 65;
          while (performance.now() < until) {
            // Synchronous CPU prologue exceeding the 40ms budget.
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
          return 'late-after-sync';
        },
        { timeout: 40 },
      ),
    ).rejects.toBeInstanceOf(TimeoutError);
    // Rejects immediately once the synchronous prologue returns, without waiting another 40ms.
    expect(performance.now() - syncStarted).toBeLessThan(120);

    // 7. Concurrent executionTimeout calls coalesce guard initialization and repeated helper
    //    lifecycles on the same named world keep the global guard property count bounded to 1.
    const guarded = createIsolatedWorld(session, { worldName: 'w-guarded' });
    const guardCallsBefore = sent.filter(
      (m) =>
        m.method === 'Runtime.callFunctionOn' &&
        String(m.params.functionDeclaration ?? '').includes('Object.defineProperty'),
    ).length;
    const concurrentGuarded = await Promise.all(
      Array.from({ length: 8 }, () =>
        guarded.evaluate<string>('1', undefined, { executionTimeout: 500 }),
      ),
    );
    expect(concurrentGuarded.every((v) => v.endsWith(':w-guarded'))).toBe(true);
    expect(
      sent.filter(
        (m) =>
          m.method === 'Runtime.callFunctionOn' &&
          String(m.params.functionDeclaration ?? '').includes('Object.defineProperty'),
      ).length,
    ).toBe(guardCallsBefore + 1);
    guarded.dispose();
    for (let i = 0; i < 3; i++) {
      const again = createIsolatedWorld(session, { worldName: 'w-guarded' });
      expect(await again.evaluate<string>('1', undefined, { executionTimeout: 500 })).toMatch(
        /:w-guarded$/,
      );
      again.dispose();
    }
    const guardedCtx = namedWorlds.get(`${isolate}\0target-race\0w-guarded`)!;
    expect(worlds.get(`${isolate}.${guardedCtx}`)!.guards.size).toBe(1);

    expect(sent.some((m) => m.method.endsWith('.enable'))).toBe(false);
  } finally {
    await connection.close();
  }
});

test('IsolatedWorld dispose settles pending creation immediately, cleans late replies once, and blocks warm run/evaluate after microtask dispose', async () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  const releasedGroups: string[] = [];
  let releaseGlobalThis!: () => void;
  let globalThisArrived!: () => void;
  const globalThisReady = new Promise<void>((r) => {
    globalThisArrived = r;
  });
  const globalThisGate = new Promise<void>((r) => {
    releaseGlobalThis = r;
  });
  let pauseGlobalThis = true;
  let onVerifyReplied: (() => void) | undefined;
  let userEvaluations = 0;
  const transport: Transport = {
    send(raw: string) {
      const m = JSON.parse(raw) as {
        id: number;
        sessionId?: string;
        method: string;
        params?: Record<string, unknown>;
      };
      sent.push({ method: m.method, params: m.params ?? {} });
      queueMicrotask(() => {
        if (m.method === 'Target.attachToTarget') {
          this.onmessage?.(JSON.stringify({ id: m.id, result: { sessionId: 'sess-disp' } }));
          return;
        }
        if (m.method === 'Runtime.releaseObjectGroup') {
          releasedGroups.push(String(m.params?.objectGroup ?? ''));
          this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: {} }));
          return;
        }
        if (m.method === 'Page.createIsolatedWorld') {
          this.onmessage?.(
            JSON.stringify({ id: m.id, sessionId: m.sessionId, result: { executionContextId: 2 } }),
          );
          return;
        }
        if (m.method === 'Runtime.evaluate' && m.params?.expression === 'globalThis') {
          const reply = () =>
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId: '1.2.1' } },
              }),
            );
          if (pauseGlobalThis) {
            pauseGlobalThis = false;
            globalThisArrived();
            void globalThisGate.then(reply);
          } else {
            reply();
          }
          return;
        }
        if (m.method === 'DOM.describeNode') {
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { node: { backendNodeId: 77, frameId: 'target-disp' } },
            }),
          );
          return;
        }
        if (m.method === 'DOM.resolveNode') {
          const ctx = (m.params?.executionContextId as number | undefined) ?? 1;
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { object: { type: 'object', objectId: `1.${ctx}.3` } },
            }),
          );
          return;
        }
        if (m.method === 'Runtime.callFunctionOn') {
          const fnDecl = String(m.params?.functionDeclaration ?? '');
          if (fnDecl === 'function(){return this.document}') {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId: '1.2.2' } },
              }),
            );
            return;
          }
          if (fnDecl === 'function(other){return this === other}') {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'boolean', value: true } },
              }),
            );
            return;
          }
          if (fnDecl === 'function(){return 1}') {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'number', value: 1 } },
              }),
            );
            onVerifyReplied?.();
            return;
          }
        }
        userEvaluations++;
        this.onmessage?.(
          JSON.stringify({
            id: m.id,
            sessionId: m.sessionId,
            result: { result: { type: 'number', value: 1 } },
          }),
        );
      });
    },
    close() {},
  };
  const connection = new Connection(transport);
  try {
    const session = await connection.attachSession('target-disp');
    const listenersBefore = session.disconnected.size;
    const world = createIsolatedWorld(session, { worldName: 'w-disp' });
    const pendingEval = world.evaluate<number>('1 + 1').catch((e) => e);
    await globalThisReady;

    // 1. Dispose while globalThis binding is still HUNG: caller must settle IMMEDIATELY
    //    without waiting for the hung CDP reply!
    world.dispose();
    const settled = await Promise.race([
      pendingEval.then((err) => ({ kind: 'settled' as const, err })),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), 40),
      ),
    ]);
    expect(settled.kind).toBe('settled');
    if (settled.kind === 'settled') {
      expect(settled.err).toBeInstanceOf(StaleElementError);
      expect(String(settled.err)).toMatch(/disposed/);
    }
    expect(releasedGroups.length).toBe(0);

    // Late globalThis reply arrives later -> cleaned up ONCE, no rebuild, no user eval, no listeners.
    releaseGlobalThis();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sent.filter((m) => m.method === 'Page.createIsolatedWorld').length).toBe(1);
    expect(userEvaluations).toBe(0);
    expect(releasedGroups.length).toBe(1);
    expect(session.disconnected.size).toBe(listenersBefore);

    // 2. Warm cache: dispose right after acquire()'s last check and before run() resumes
    //    must NEVER invoke the user callback!
    const warm = createIsolatedWorld(session, { worldName: 'w-warm-disp' });
    expect(await warm.context()).toBe(2);
    let callbackInvocations = 0;
    onVerifyReplied = () => {
      onVerifyReplied = undefined;
      // Schedule after verifyEntry/acquire microtasks finish, right before run() resumes.
      void Promise.resolve()
        .then(() => {})
        .then(() => warm.dispose());
    };
    const runErr = await warm
      .run(async () => {
        callbackInvocations++;
        return 'ran-after-dispose';
      })
      .catch((e) => e);
    expect(runErr).toBeInstanceOf(StaleElementError);
    expect(String(runErr)).toMatch(/disposed/);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(callbackInvocations).toBe(0);

    // Same microtask gap for warm evaluate() when dispose() is called synchronously after launch.
    const warmEval = createIsolatedWorld(session, { worldName: 'w-warm-eval-disp' });
    expect(await warmEval.context()).toBe(2);
    const evalsBefore = userEvaluations;
    const warmEvalPromise = warmEval.evaluate<number>('1 + 1').catch((e) => e);
    warmEval.dispose();
    const warmEvalErr = await warmEvalPromise;
    expect(warmEvalErr).toBeInstanceOf(StaleElementError);
    expect(userEvaluations).toBe(evalsBefore);
    expect(session.disconnected.size).toBe(listenersBefore);
  } finally {
    await connection.close();
  }
});

test('scope "target" reuses isolated worlds across ephemeral TargetSessions with verified guard bind, 1-RTT warm hit, unwrapped none, 0-RTT context/run, eval flags, and lifecycle telemetry', async () => {
  let isolate = 1;
  let nextContext = 1;
  let sessionSeq = 0;
  let objectSeq = 0;
  let failCreateOnce = false;
  type TargetWorld = {
    isolate: number;
    contextId: number;
    frameId: string;
    worldName: string;
    isMain: boolean;
    props: Map<string, { value: string; configurable: boolean; writable: boolean }>;
  };
  const namedWorlds = new Map<string, number>();
  const worlds = new Map<string, TargetWorld>();
  const objectMap = new Map<string, { isolate: number; contextId: number; group: string }>();
  const releasedGroups: string[] = [];
  const sent: Array<{ method: string; sessionId?: string; params: Record<string, unknown> }> = [];

  const ensureMain = (frameId: string) => {
    const key = `${isolate}.1`;
    if (!worlds.has(key)) {
      worlds.set(key, {
        isolate,
        contextId: 1,
        frameId,
        worldName: '',
        isMain: true,
        props: new Map(),
      });
    }
  };

  const transport: Transport = {
    send(raw: string) {
      const m = JSON.parse(raw) as {
        id: number;
        sessionId?: string;
        method: string;
        params?: Record<string, unknown>;
      };
      sent.push({ method: m.method, sessionId: m.sessionId, params: m.params ?? {} });
      queueMicrotask(() => {
        if (m.method === 'Target.attachToTarget') {
          const sessionId = `ephem-${++sessionSeq}`;
          const targetId = String(m.params?.targetId ?? '');
          ensureMain(targetId);
          this.onmessage?.(
            JSON.stringify({
              method: 'Target.attachedToTarget',
              params: {
                sessionId,
                targetInfo: {
                  targetId,
                  type: 'page',
                  title: '',
                  url: 'about:blank',
                  attached: true,
                  canAccessOpener: false,
                },
                waitingForDebugger: false,
              },
            }),
          );
          this.onmessage?.(JSON.stringify({ id: m.id, result: { sessionId } }));
          return;
        }
        if (m.method === 'Target.detachFromTarget') {
          const sid = String(m.params?.sessionId ?? '');
          this.onmessage?.(
            JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: sid } }),
          );
          this.onmessage?.(JSON.stringify({ id: m.id, result: {} }));
          return;
        }
        if (m.method === 'Runtime.releaseObjectGroup') {
          const group = String(m.params?.objectGroup ?? '');
          releasedGroups.push(group);
          for (const [oid, meta] of objectMap) {
            if (meta.group === group) objectMap.delete(oid);
          }
          this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, result: {} }));
          return;
        }
        if (m.method === 'Page.createIsolatedWorld') {
          if (failCreateOnce) {
            failCreateOnce = false;
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Execution context was destroyed.' },
              }),
            );
            return;
          }
          const frameId = String(m.params?.frameId ?? '');
          const worldName = String(m.params?.worldName ?? '');
          const mapKey = `${isolate}\0${frameId}\0${worldName}`;
          let executionContextId = namedWorlds.get(mapKey);
          if (executionContextId === undefined) {
            executionContextId = ++nextContext;
            namedWorlds.set(mapKey, executionContextId);
            worlds.set(`${isolate}.${executionContextId}`, {
              isolate,
              contextId: executionContextId,
              frameId,
              worldName,
              isMain: false,
              props: new Map(),
            });
          }
          this.onmessage?.(
            JSON.stringify({ id: m.id, sessionId: m.sessionId, result: { executionContextId } }),
          );
          return;
        }
        if (m.method === 'DOM.resolveNode') {
          const ctx = m.params?.executionContextId as number | undefined;
          expect(typeof ctx).toBe('number');
          const target = worlds.get(`${isolate}.${ctx}`);
          if (!target) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Cannot find context with specified id' },
              }),
            );
            return;
          }
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: { object: { type: 'object', objectId: `${isolate}.${ctx}.99` } },
            }),
          );
          return;
        }
        if (m.method === 'Runtime.callFunctionOn') {
          const oid = String(m.params?.objectId ?? '');
          const meta = objectMap.get(oid);
          if (!meta || meta.isolate !== isolate) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Could not find object with given id' },
              }),
            );
            return;
          }
          const target = worlds.get(`${meta.isolate}.${meta.contextId}`);
          if (!target) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Cannot find context with specified id' },
              }),
            );
            return;
          }
          const fnDecl = String(m.params?.functionDeclaration ?? '');
          if (fnDecl.includes('defineProperty')) {
            const args = (m.params?.arguments as Array<{ value?: unknown }>) ?? [];
            const key = String(args[0]?.value ?? '');
            const proposed = String(args[1]?.value ?? '');
            const existing = target.props.get(key);
            const val = existing ? existing.value : proposed;
            if (!existing)
              target.props.set(key, { value: val, configurable: false, writable: false });
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'string', value: val } },
              }),
            );
            return;
          }
          throw new Error(`Unexpected Runtime.callFunctionOn: ${fnDecl}`);
        }
        if (m.method === 'Runtime.evaluate') {
          const ctx = m.params?.contextId as number | undefined;
          expect(typeof ctx).toBe('number');
          const target = worlds.get(`${isolate}.${ctx}`);
          if (!target) {
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                error: { code: -32000, message: 'Cannot find context with specified id' },
              }),
            );
            return;
          }
          const expr = String(m.params?.expression ?? '');

          // 1) globalThis handle binding during verified guard cold start
          if (expr === 'globalThis') {
            const objectId = `${isolate}.${ctx}.${++objectSeq}`;
            objectMap.set(objectId, {
              isolate,
              contextId: ctx!,
              group: String(m.params?.objectGroup ?? ''),
            });
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'object', objectId } },
              }),
            );
            return;
          }

          // 2) Guard-checked function expression (no eval, no shadowed locals)
          const fnGuardMatch = !expr.includes('(0,eval)(')
            ? expr.match(
                /getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value==="(ndg:[^"]+)"\}catch\{return false\}\}\)\(\)\?(\([\s\S]+\)\([\s\S]*\)):\(\(\)=>\{throw "(__nodriver_iso_mismatch_[^"]+)"\}\)\(\)$/,
              )
            : null;
          if (fnGuardMatch) {
            const [, key, token, invocation, mismatch] = fnGuardMatch;
            const existing = target.props.get(key!);
            if (!existing || existing.value !== token) {
              this.onmessage?.(
                JSON.stringify({
                  id: m.id,
                  sessionId: m.sessionId,
                  result: {
                    result: { type: 'string', value: mismatch },
                    exceptionDetails: {
                      exceptionId: 1,
                      text: 'Uncaught',
                      lineNumber: 0,
                      columnNumber: 0,
                      exception: { type: 'string', value: mismatch },
                    },
                  },
                }),
              );
              return;
            }
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'string', value: `${target.worldName}:${invocation}` } },
              }),
            );
            return;
          }

          // 3) Guard-checked no-eval statement block (throwOnSideEffect: true, preserves sloppy/strict mode)
          const noEvalGuardMatch = expr.match(
            /^if\(!\(\(\)=>\{try\{return Object\.getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value==="(ndg:[^"]+)"\}catch\{return false\}\}\)\(\)\)throw "(__nodriver_iso_mismatch_[^"]+)";\{\n([\s\S]*)\n\}$/,
          );
          if (noEvalGuardMatch) {
            const [, key, token, mismatch, innerCode] = noEvalGuardMatch;
            const existing = target.props.get(key!);
            if (!existing || existing.value !== token) {
              this.onmessage?.(
                JSON.stringify({
                  id: m.id,
                  sessionId: m.sessionId,
                  result: {
                    result: { type: 'string', value: mismatch },
                    exceptionDetails: {
                      exceptionId: 1,
                      text: 'Uncaught',
                      lineNumber: 0,
                      columnNumber: 0,
                      exception: { type: 'string', value: mismatch },
                    },
                  },
                }),
              );
              return;
            }
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: {
                  result: { type: 'string', value: `${target.worldName}:${innerCode}` },
                },
              }),
            );
            return;
          }

          // 4) Guard-checked string expression (default !throwOnSideEffect)
          const warmGuardMatch = expr.match(
            /getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value==="(ndg:[^"]+)"\}catch\{return false\}\}\)\(\)\?\(0,eval\)\((.+)\):\(\(\)=>\{throw "(__nodriver_iso_mismatch_[^"]+)"\}\)\(\)$/,
          );
          if (warmGuardMatch) {
            const [, key, token, encodedCode, mismatch] = warmGuardMatch;
            const existing = target.props.get(key!);
            if (!existing || existing.value !== token) {
              this.onmessage?.(
                JSON.stringify({
                  id: m.id,
                  sessionId: m.sessionId,
                  result: {
                    result: { type: 'string', value: mismatch },
                    exceptionDetails: {
                      exceptionId: 1,
                      text: 'Uncaught',
                      lineNumber: 0,
                      columnNumber: 0,
                      exception: { type: 'string', value: mismatch },
                    },
                  },
                }),
              );
              return;
            }
            const innerCode = JSON.parse(encodedCode!) as string;
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: {
                  result: {
                    type: 'string',
                    value: `${target.worldName}:${innerCode}`,
                  },
                },
              }),
            );
            return;
          }

          // 5) verifyGuardEntry (for warm context() / run() in 'guard' mode)
          const verifyGuardMatch = expr.match(
            /getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value!=="(ndg:[^"]+)"\)throw 0\}catch\{throw "(__nodriver_iso_mismatch_[^"]+)"\};return 1/,
          );
          if (verifyGuardMatch) {
            const [, key, token, mismatch] = verifyGuardMatch;
            const existing = target.props.get(key!);
            if (!existing || existing.value !== token) {
              this.onmessage?.(
                JSON.stringify({
                  id: m.id,
                  sessionId: m.sessionId,
                  result: {
                    result: { type: 'string', value: mismatch },
                    exceptionDetails: {
                      exceptionId: 1,
                      text: 'Uncaught',
                      lineNumber: 0,
                      columnNumber: 0,
                      exception: { type: 'string', value: mismatch },
                    },
                  },
                }),
              );
              return;
            }
            this.onmessage?.(
              JSON.stringify({
                id: m.id,
                sessionId: m.sessionId,
                result: { result: { type: 'number', value: 1 } },
              }),
            );
            return;
          }

          // 6) Unwrapped raw expression (verification: 'none')
          this.onmessage?.(
            JSON.stringify({
              id: m.id,
              sessionId: m.sessionId,
              result: {
                result: {
                  type: 'string',
                  value: `raw:${target.worldName}:${expr}`,
                },
              },
            }),
          );
          return;
        }
        throw new Error(`Unexpected CDP command in target-scope test: ${m.method}`);
      });
    },
    close() {},
  };

  const connection = new Connection(transport);
  try {
    const baselineEvents = connection.events.size;
    const events: IsolatedWorldEvent[] = [];
    const onEvent = (e: IsolatedWorldEvent) => events.push(e);

    // Reject invalid scope: 'target' + verification: 'strict'
    const sInit = await connection.attachSession('tab-1');
    expect(() => createIsolatedWorld(sInit, { scope: 'target', verification: 'strict' })).toThrow(
      TypeError,
    );
    await sInit.detach();

    // --- Part A: Default scope: 'target' uses verification: 'guard' with verified cold bind (zero DOM.*) & 1-RTT warm start across ephemeral sessions ---
    const s1 = await connection.attachSession('tab-1');
    const beforeColdGuard = sent.length;
    const r1 = await evaluateIsolated<string>(s1, 'probe()', undefined, {
      scope: 'target',
      worldName: 'exam-guard',
      silent: true,
      disableBreaks: true,
      onEvent,
    });
    expect(r1).toBe('exam-guard:probe()');
    const coldGuardCmds = sent.slice(beforeColdGuard);
    expect(coldGuardCmds.map((c) => c.method)).toEqual([
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
      'Page.createIsolatedWorld',
      'Runtime.callFunctionOn',
      'Runtime.releaseObjectGroup',
      'Runtime.evaluate',
    ]);
    expect(coldGuardCmds.some((c) => c.method.startsWith('DOM.'))).toBe(false);
    const userEvalCmd = coldGuardCmds[5]!;
    expect(userEvalCmd.params.silent).toBe(true);
    expect(userEvalCmd.params.disableBreaks).toBe(true);
    expect('throwOnSideEffect' in userEvalCmd.params).toBe(false);
    expect('userGesture' in userEvalCmd.params).toBe(false);
    expect(releasedGroups.length).toBe(1);
    expect(events).toEqual(['created']);
    await s1.detach();

    // Ephemeral session 2 attaches -> warm cache hit in 1 SINGLE RTT!
    const s2 = await connection.attachSession('tab-1');
    const beforeWarmGuard = sent.length;
    const r2 = await evaluateIsolated<string, { id: number; arr: unknown[] }>(
      s2,
      (arg) => String(arg.id),
      { id: 7, arr: Array(1) },
      {
        scope: 'target',
        worldName: 'exam-guard',
        silent: true,
        disableBreaks: true,
        throwOnSideEffect: true,
        userGesture: false,
        onEvent,
      },
    );
    expect(r2).toContain('exam-guard:((arg) => String(arg.id))({"id":7,"arr":[null]})');
    const warmGuardCmds = sent.slice(beforeWarmGuard);
    expect(warmGuardCmds.map((c) => c.method)).toEqual(['Runtime.evaluate']);
    expect(warmGuardCmds[0]!.params.throwOnSideEffect).toBe(true);
    expect(warmGuardCmds[0]!.params.userGesture).toBe(false);
    expect(events).toEqual(['created']); // No new creation!

    // Cross-process navigation reuses numeric contextId=2 for MAIN world:
    // retryOnContextGone: false surfaces an error matching isContextGone(err) without running user code,
    // and the next session recovers and emits 'recovered'!
    isolate = 2;
    nextContext = 2;
    worlds.set('2.2', {
      isolate: 2,
      contextId: 2,
      frameId: 'tab-1',
      worldName: '',
      isMain: true,
      props: new Map(),
    });
    const mismatchErr = await evaluateIsolated(s2, 'probe()', undefined, {
      scope: 'target',
      worldName: 'exam-guard',
      retryOnContextGone: false,
      onEvent,
    }).catch((e) => e);
    expect(isContextGone(mismatchErr)).toBe(true);
    await s2.detach();

    const s3 = await connection.attachSession('tab-1');
    const r3 = await evaluateIsolated<string>(s3, 'afterSwap()', undefined, {
      scope: 'target',
      worldName: 'exam-guard',
      onEvent,
    });
    expect(r3).toBe('exam-guard:afterSwap()');
    expect(events).toEqual(['created', 'recovered']);

    // Cold start WITH throwOnSideEffect: true stamps guard via handle without throwOnSideEffect, then evaluates no-eval block with throwOnSideEffect: true!
    const beforeSide = sent.length;
    const rSide = await evaluateIsolated<string>(s3, 'pureRead()', undefined, {
      scope: 'target',
      worldName: 'exam-side-effect',
      throwOnSideEffect: true,
      silent: true,
      onEvent,
    });
    expect(rSide).toBe('exam-side-effect:pureRead()');
    const sideCmds = sent.slice(beforeSide);
    const sideUserEval = sideCmds[sideCmds.length - 1]!;
    expect(sideUserEval.params.throwOnSideEffect).toBe(true);
    expect(String(sideUserEval.params.expression)).not.toContain('(0,eval)');
    expect(events).toEqual(['created', 'recovered', 'created']);
    await s3.detach();

    // --- Part B: verification: 'none' sends unwrapped expression, 0-RTT context()/run(), and dispose() keeps shared cache ---
    const noneEvents: IsolatedWorldEvent[] = [];
    const recordNone = (e: IsolatedWorldEvent) => noneEvents.push(e);
    const s4 = await connection.attachSession('tab-1');
    const beforeColdNone = sent.length;
    const rawRes = await evaluateIsolated<string>(s4, 'document.title', undefined, {
      scope: 'target',
      verification: 'none',
      worldName: 'raw-probe',
      silent: true,
      disableBreaks: true,
      onEvent: recordNone,
    });
    expect(rawRes).toBe('raw:raw-probe:document.title');
    const coldNoneCmds = sent.slice(beforeColdNone);
    expect(coldNoneCmds.map((c) => c.method)).toEqual([
      'Page.createIsolatedWorld',
      'Runtime.evaluate',
    ]);
    // Expression is sent 100% verbatim without any wrapper!
    expect(coldNoneCmds[1]!.params.expression).toBe('document.title');
    expect(noneEvents).toEqual(['created']);

    // Create wrapper on s4, call context() in 0 RTT, then dispose() wrapper AND detach s4
    const w4 = createIsolatedWorld(s4, {
      scope: 'target',
      verification: 'none',
      worldName: 'raw-probe',
    });
    const beforeZeroRtt = sent.length;
    const ctx4 = await w4.context();
    expect(sent.length).toBe(beforeZeroRtt); // 0 RTT!
    w4.dispose(); // Must NOT evict the shared target cache!
    await s4.detach();

    // Ephemeral session s5: w5.context() and w5.run(DOM.resolveNode) hit shared cache in 0 setup RTT!
    const s5 = await connection.attachSession('tab-1');
    const w5 = createIsolatedWorld(s5, {
      scope: 'target',
      verification: 'none',
      worldName: 'raw-probe',
      onEvent: recordNone,
    });
    const beforeS5 = sent.length;
    expect(await w5.context()).toBe(ctx4);
    expect(sent.length).toBe(beforeS5); // 0 RTT across sessions even after w4.dispose()!
    const resolved = await w5.run((executionContextId, step) =>
      s5.sendWith('DOM.resolveNode', step(), { backendNodeId: 10, executionContextId }),
    );
    expect(resolved.object.objectId).toBe(`2.${ctx4}.99`);
    expect(sent.slice(beforeS5).map((c) => c.method)).toEqual(['DOM.resolveNode']);

    // Simulate navigation + failed first creation attempt -> 'create-failed' then 'recovered'
    isolate = 3;
    nextContext = 10;
    failCreateOnce = true;
    await expect(
      w5.run(
        (executionContextId, step) =>
          s5.sendWith('DOM.resolveNode', step(), { backendNodeId: 10, executionContextId }),
        { retryOnContextGone: true },
      ),
    ).rejects.toBeInstanceOf(ProtocolError);
    // First attempt inside run() hit stale ctx4 (marked slot recovering), retry attempt failed create ('create-failed').
    expect(noneEvents).toEqual(['created', 'create-failed']);
    // Next call succeeds and reports 'recovered'!
    const resolvedAfter = await w5.run((executionContextId, step) =>
      s5.sendWith('DOM.resolveNode', step(), { backendNodeId: 10, executionContextId }),
    );
    expect(resolvedAfter.object.objectId).toBe('3.11.99');
    expect(noneEvents).toEqual(['created', 'create-failed', 'recovered']);

    // Target.targetDestroyed passively evicts target cache and cleans up root listeners when empty!
    await s5.detach();
    transport.onmessage?.(
      JSON.stringify({ method: 'Target.targetDestroyed', params: { targetId: 'tab-1' } }),
    );
    expect(connection.events.size).toBe(baselineEvents);
    const s6 = await connection.attachSession('tab-1');
    const w6 = createIsolatedWorld(s6, {
      scope: 'target',
      verification: 'none',
      worldName: 'raw-none',
    });
    const beforeRebind = sent.length;
    await w6.context();
    expect(sent.slice(beforeRebind).map((c) => c.method)).toEqual(['Page.createIsolatedWorld']);

    // Explicit invalidateIsolatedWorlds also cleans up entries and root listeners!
    invalidateIsolatedWorlds(connection, { targetId: 'tab-1' });
    expect(connection.events.size).toBe(baselineEvents);
    const beforeAfterExplicit = sent.length;
    await w6.context();
    expect(sent.slice(beforeAfterExplicit).map((c) => c.method)).toEqual([
      'Page.createIsolatedWorld',
    ]);
    await s6.detach();
  } finally {
    await connection.close();
  }
});

test('guard cold-bind rejects cross-process swap before mutating main world, cold context() seeds guard, dispose() settles active run()/evaluate() immediately, and concurrent invalidateIsolatedWorlds() caches retry in active slot', async () => {
  let isolate = 1;
  let nextContext = 1;
  let sessionSeq = 0;
  let objectSeq = 0;
  let swapAfterFirstCreate = false;
  let swapAfterConfirmCreate = false;
  let createCalls = 0;
  let holdCreateReply: (() => void) | undefined;
  let holdNextCreate = false;
  let holdEvalReply: (() => void) | undefined;
  let holdNextEval = false;
  let mainWorldUserRuns = 0;
  const releasedGroups: string[] = [];

  type SimWorld = {
    isolate: number;
    contextId: number;
    worldName: string;
    isMain: boolean;
    props: Map<string, string>;
  };
  const namedWorlds = new Map<string, number>();
  const worlds = new Map<string, SimWorld>();
  const objects = new Map<string, { isolate: number; contextId: number; group: string }>();

  const makeMainWorld = (iso: number, ctxId: number) => {
    const w: SimWorld = {
      isolate: iso,
      contextId: ctxId,
      worldName: '',
      isMain: true,
      props: new Map(),
    };
    worlds.set(`${iso}.${ctxId}`, w);
    return w;
  };
  makeMainWorld(1, 1);

  const transport: Transport = {
    send(raw: string) {
      const m = JSON.parse(raw) as {
        id: number;
        sessionId?: string;
        method: string;
        params?: Record<string, unknown>;
      };
      const reply = (payload: Record<string, unknown>) =>
        this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, ...payload }));
      queueMicrotask(() => {
        if (m.method === 'Target.attachToTarget') {
          const sessionId = `sim-${++sessionSeq}`;
          const targetId = String(m.params?.targetId ?? '');
          this.onmessage?.(
            JSON.stringify({
              method: 'Target.attachedToTarget',
              params: {
                sessionId,
                targetInfo: {
                  targetId,
                  type: 'page',
                  title: '',
                  url: 'about:blank',
                  attached: true,
                  canAccessOpener: false,
                },
                waitingForDebugger: false,
              },
            }),
          );
          this.onmessage?.(JSON.stringify({ id: m.id, result: { sessionId } }));
          return;
        }
        if (m.method === 'Target.detachFromTarget') {
          const sid = String(m.params?.sessionId ?? '');
          this.onmessage?.(
            JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: sid } }),
          );
          this.onmessage?.(JSON.stringify({ id: m.id, result: {} }));
          return;
        }
        if (m.method === 'Runtime.releaseObjectGroup') {
          const grp = String(m.params?.objectGroup ?? '');
          releasedGroups.push(grp);
          for (const [oid, meta] of objects) if (meta.group === grp) objects.delete(oid);
          reply({ result: {} });
          return;
        }
        if (m.method === 'Page.createIsolatedWorld') {
          createCalls++;
          const frameId = String(m.params?.frameId ?? '');
          const worldName = String(m.params?.worldName ?? '');
          const mapKey = `${isolate}\0${frameId}\0${worldName}`;
          let executionContextId = namedWorlds.get(mapKey);
          if (executionContextId === undefined) {
            executionContextId = ++nextContext;
            namedWorlds.set(mapKey, executionContextId);
            worlds.set(`${isolate}.${executionContextId}`, {
              isolate,
              contextId: executionContextId,
              worldName,
              isMain: false,
              props: new Map(),
            });
          }
          const respond = () => {
            reply({ result: { executionContextId } });
            if (swapAfterFirstCreate) {
              swapAfterFirstCreate = false;
              isolate++;
              nextContext = executionContextId!;
              makeMainWorld(isolate, executionContextId!);
            } else if (swapAfterConfirmCreate && createCalls % 2 === 0) {
              swapAfterConfirmCreate = false;
              isolate++;
              nextContext = executionContextId!;
              makeMainWorld(isolate, executionContextId!);
            }
          };
          if (holdNextCreate) {
            holdNextCreate = false;
            holdCreateReply = respond;
            return;
          }
          respond();
          return;
        }
        if (m.method === 'Runtime.callFunctionOn') {
          const oid = String(m.params?.objectId ?? '');
          const meta = objects.get(oid);
          if (!meta || meta.isolate !== isolate) {
            reply({ error: { code: -32000, message: 'Could not find object with given id' } });
            return;
          }
          const target = worlds.get(`${meta.isolate}.${meta.contextId}`)!;
          const fnDecl = String(m.params?.functionDeclaration ?? '');
          if (fnDecl.includes('defineProperty')) {
            const args = (m.params?.arguments as Array<{ value?: unknown }>) ?? [];
            const key = String(args[0]?.value ?? '');
            const proposed = String(args[1]?.value ?? '');
            const val = target.props.get(key) ?? proposed;
            target.props.set(key, val);
            reply({ result: { result: { type: 'string', value: val } } });
            return;
          }
          const respond = () => reply({ result: { result: { type: 'number', value: 42 } } });
          if (holdNextEval) {
            holdNextEval = false;
            holdEvalReply = respond;
            return;
          }
          respond();
          return;
        }
        if (m.method === 'Runtime.evaluate') {
          const ctx = Number(m.params?.contextId);
          const target = worlds.get(`${isolate}.${ctx}`);
          if (!target) {
            reply({ error: { code: -32000, message: 'Cannot find context with specified id' } });
            return;
          }
          const expr = String(m.params?.expression ?? '');
          if (expr === 'globalThis') {
            const oid = `${isolate}.${ctx}.${++objectSeq}`;
            objects.set(oid, {
              isolate,
              contextId: ctx,
              group: String(m.params?.objectGroup ?? ''),
            });
            reply({ result: { result: { type: 'object', objectId: oid } } });
            return;
          }
          const respond = () => {
            const guardMatch = expr.match(
              /getOwnPropertyDescriptor\(globalThis,"([^"]+)"\)\?\.value==="(ndg:[^"]+)"[\s\S]*throw "(__nodriver_iso_mismatch_[^"]+)"/,
            );
            if (guardMatch) {
              const [, key, token, mismatch] = guardMatch;
              if (target.props.get(key!) !== token) {
                reply({
                  result: {
                    result: { type: 'string', value: mismatch },
                    exceptionDetails: {
                      exceptionId: 1,
                      text: 'Uncaught',
                      lineNumber: 0,
                      columnNumber: 0,
                      exception: { type: 'string', value: mismatch },
                    },
                  },
                });
                return;
              }
            }
            if (target.isMain) mainWorldUserRuns++;
            reply({ result: { result: { type: 'number', value: 42 } } });
          };
          if (holdNextEval) {
            holdNextEval = false;
            holdEvalReply = respond;
            return;
          }
          respond();
          return;
        }
        throw new Error(`Unexpected CDP command: ${m.method}`);
      });
    },
    close() {},
  };

  const connection = new Connection(transport);
  try {
    const s = await connection.attachSession('tab-1');

    // 1. P1 #1a: Cross-process swap right after first Page.createIsolatedWorld (reusing ctxId=2 as NEW main world)
    // Must detect mismatch on confirming Page.createIsolatedWorld, write ZERO properties to main world, run ZERO user code there, and recover in real isolated world!
    swapAfterFirstCreate = true;
    const beforeRelease1 = releasedGroups.length;
    const rSwap1 = await evaluateIsolated<number>(s, '42', undefined, {
      scope: 'target',
      worldName: 'swap-before-bind',
    });
    expect(rSwap1).toBe(42);
    expect(mainWorldUserRuns).toBe(0);
    expect(worlds.get('2.2')!.props.size).toBe(0); // Main world in isolate 2 stayed completely untouched!
    expect(releasedGroups.length - beforeRelease1).toBe(2); // Failed attempt + recovered attempt each released once

    // 2. P1 #1b: Cross-process swap right after confirming Page.createIsolatedWorld (before stamp Runtime.callFunctionOn)
    // Stale objectId is rejected by V8 without mutating the new renderer's main world!
    createCalls = 0;
    swapAfterConfirmCreate = true;
    const rSwap2 = await evaluateIsolated<number>(s, '42', undefined, {
      scope: 'target',
      worldName: 'swap-before-stamp',
    });
    expect(rSwap2).toBe(42);
    expect(mainWorldUserRuns).toBe(0);
    const swappedMain = worlds.get(`${isolate}.${nextContext - 1}`);
    expect(swappedMain?.isMain).toBe(true);
    expect(swappedMain?.props.size).toBe(0);

    // 3. P1 #1c: Cold context() in 'guard' mode seeds guard BEFORE returning; subsequent process swap reusing numeric ID fails closed!
    const wCold = createIsolatedWorld(s, {
      scope: 'target',
      verification: 'guard',
      worldName: 'cold-ctx-guard',
    });
    const coldCtxId = await wCold.context();
    expect(worlds.get(`${isolate}.${coldCtxId}`)!.props.size).toBe(1);
    isolate++;
    nextContext = coldCtxId;
    const newMain = makeMainWorld(isolate, coldCtxId);
    const errAfterColdCtx = await wCold
      .evaluate('42', undefined, { retryOnContextGone: false })
      .catch((e) => e);
    expect(isContextGone(errAfterColdCtx)).toBe(true);
    expect(newMain.props.size).toBe(0);
    expect(mainWorldUserRuns).toBe(0);

    // 4. P2 #1: dispose() settles already-running run() callbacks AND in-flight evaluate() commands IMMEDIATELY
    const wDispose = createIsolatedWorld(s, {
      scope: 'target',
      verification: 'none',
      worldName: 'dispose-inflight',
    });
    await wDispose.context();
    let resolveRunTask!: (v: string) => void;
    let settledRun = false;
    const runPromise = wDispose
      .run(
        () =>
          new Promise<string>((resolve) => {
            resolveRunTask = resolve;
          }),
      )
      .then(
        (v) => {
          settledRun = true;
          return v;
        },
        (e) => {
          settledRun = true;
          return e;
        },
      );
    await new Promise((r) => setTimeout(r, 10));
    expect(settledRun).toBe(false);
    wDispose.dispose();
    const runOutcome = await runPromise;
    expect(runOutcome).toBeInstanceOf(StaleElementError);
    resolveRunTask('late-callback-value');
    await new Promise((r) => setTimeout(r, 10));

    // In-flight evaluate() across 'strict' (session), 'none' and 'guard' settles immediately on dispose() without waiting for CDP reply
    for (const verification of ['none', 'guard'] as const) {
      const wEval = createIsolatedWorld(s, {
        scope: 'target',
        verification,
        worldName: `dispose-eval-${verification}`,
      });
      await wEval.context();
      holdNextEval = true;
      let evalSettled = false;
      const evalPromise = wEval.evaluate('42').then(
        (v) => {
          evalSettled = true;
          return v;
        },
        (e) => {
          evalSettled = true;
          return e;
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(evalSettled).toBe(false);
      expect(typeof holdEvalReply).toBe('function');
      wEval.dispose();
      const evalOutcome = await evalPromise;
      expect(evalOutcome).toBeInstanceOf(StaleElementError);
      const release = holdEvalReply!;
      holdEvalReply = undefined;
      release();
      await new Promise((r) => setTimeout(r, 10));
    }

    // Also verify session-scoped 'guard' in-flight evaluate() rejects immediately on dispose()
    {
      const wSessGuard = createIsolatedWorld(s, {
        scope: 'session',
        verification: 'guard',
        worldName: 'dispose-eval-session-guard',
      });
      await wSessGuard.context();
      holdNextEval = true;
      let settled = false;
      const p = wSessGuard.evaluate('42').then(
        (v) => {
          settled = true;
          return v;
        },
        (e) => {
          settled = true;
          return e;
        },
      );
      await new Promise((r) => setTimeout(r, 10));
      expect(settled).toBe(false);
      wSessGuard.dispose();
      expect(await p).toBeInstanceOf(StaleElementError);
      const release = holdEvalReply!;
      holdEvalReply = undefined;
      release();
      await new Promise((r) => setTimeout(r, 10));
    }

    // 5. P2 #2: Concurrent invalidateIsolatedWorlds() during in-flight creation re-fetches active slot on retry
    // Total Page.createIsolatedWorld calls = 2 (initial + 1 retry), and immediate follow-up context() hits cache (0 extra)!
    createCalls = 0;
    holdNextCreate = true;
    const wInv = createIsolatedWorld(s, {
      scope: 'target',
      verification: 'none',
      worldName: 'concurrent-invalidate',
    });
    const pendingCtx = wInv.context();
    await new Promise((r) => setTimeout(r, 10));
    expect(typeof holdCreateReply).toBe('function');
    invalidateIsolatedWorlds(connection, { targetId: 'tab-1', worldName: 'concurrent-invalidate' });
    const releaseCreate = holdCreateReply!;
    holdCreateReply = undefined;
    releaseCreate();
    const ctxAfterRetry = await pendingCtx;
    expect(typeof ctxAfterRetry).toBe('number');
    expect(createCalls).toBe(2);
    const cachedCtx = await wInv.context();
    expect(cachedCtx).toBe(ctxAfterRetry);
    expect(createCalls).toBe(2); // Must NOT send a 3rd Page.createIsolatedWorld!

    await s.detach();
  } finally {
    await connection.close();
  }
});

test('real V8 inspector verifies throwOnSideEffect: true and sparse-array argument parity across none, guard, and strict modes', async () => {
  const v8 = new inspector.Session();
  v8.connect();
  const createdContexts: Array<{ id: number; name: string }> = [];
  v8.on('Runtime.executionContextCreated', (evt) => {
    createdContexts.push({ id: evt.params.context.id, name: evt.params.context.name });
  });
  await v8.post('Runtime.enable');

  const createRealVmContext = (label: string): number => {
    const before = createdContexts.length;
    vm.createContext({}, { name: label });
    const added = createdContexts.slice(before).find((c) => c.name === label);
    if (!added) throw new Error(`Failed to discover V8 executionContextId for ${label}`);
    return added.id;
  };

  // Real V8 contexts representing main world, isolated worlds, and a swapped unguarded world
  const mainCtxId = createRealVmContext('nd-v8-main');
  const worldContexts = new Map<string, number>();
  // Optional virtual-ID alias to simulate cross-process numeric executionContextId reuse on real V8!
  const ctxAlias = new Map<number, number>();
  const releasedObjectIds: string[] = [];
  let holdNextV8Reply: ((deliver: () => void, res: Record<string, unknown>) => void) | undefined;
  let sessionSeq = 0;

  const transport: Transport = {
    send(raw: string) {
      const m = JSON.parse(raw) as {
        id: number;
        sessionId?: string;
        method: string;
        params?: Record<string, unknown>;
      };
      const sendReply = (payload: Record<string, unknown>) =>
        this.onmessage?.(JSON.stringify({ id: m.id, sessionId: m.sessionId, ...payload }));
      void (async () => {
        try {
          if (m.method === 'Target.attachToTarget') {
            const sessionId = `v8-sess-${++sessionSeq}`;
            const targetId = String(m.params?.targetId ?? '');
            this.onmessage?.(
              JSON.stringify({
                method: 'Target.attachedToTarget',
                params: {
                  sessionId,
                  targetInfo: {
                    targetId,
                    type: 'page',
                    title: '',
                    url: 'about:blank',
                    attached: true,
                    canAccessOpener: false,
                  },
                  waitingForDebugger: false,
                },
              }),
            );
            this.onmessage?.(JSON.stringify({ id: m.id, result: { sessionId } }));
            return;
          }
          if (m.method === 'Target.detachFromTarget') {
            const sid = String(m.params?.sessionId ?? '');
            this.onmessage?.(
              JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: sid } }),
            );
            this.onmessage?.(JSON.stringify({ id: m.id, result: {} }));
            return;
          }
          if (m.method === 'Page.createIsolatedWorld') {
            const worldName = String(m.params?.worldName ?? '');
            let cid = worldContexts.get(worldName);
            if (cid === undefined) {
              cid = createRealVmContext(`nd-v8-iso-${worldName}`);
              // Populate a minimal document object so strict-mode verification can also run on real V8!
              await v8.post('Runtime.evaluate', {
                contextId: cid,
                expression: 'globalThis.document = { __ndDoc: true };',
              });
              worldContexts.set(worldName, cid);
            }
            sendReply({ result: { executionContextId: cid } });
            return;
          }
          if (m.method === 'DOM.describeNode') {
            sendReply({
              result: {
                node: {
                  nodeId: 1,
                  backendNodeId: 100,
                  nodeType: 9,
                  nodeName: '#document',
                  localName: '',
                  nodeValue: '',
                  frameId: 'v8-tab',
                },
              },
            });
            return;
          }
          if (m.method === 'DOM.resolveNode') {
            const requestedCtx = m.params?.executionContextId as number | undefined;
            const targetCtx = requestedCtx ?? mainCtxId;
            const actualCtx = ctxAlias.get(targetCtx) ?? targetCtx;
            const docRes = await v8.post('Runtime.evaluate', {
              contextId: actualCtx,
              expression: 'globalThis.document ?? (globalThis.document = { __ndDoc: true })',
              objectGroup: m.params?.objectGroup as string | undefined,
            });
            sendReply({ result: { object: docRes.result } });
            return;
          }
          if (m.method === 'Runtime.evaluate') {
            const params = { ...(m.params ?? {}) };
            if (typeof params.contextId === 'number' && ctxAlias.has(params.contextId)) {
              params.contextId = ctxAlias.get(params.contextId);
            }
            const res = (await v8.post('Runtime.evaluate', params as never)) as unknown as Record<
              string,
              unknown
            >;
            if (holdNextV8Reply) {
              const hook = holdNextV8Reply;
              holdNextV8Reply = undefined;
              hook(() => sendReply({ result: res }), res);
              return;
            }
            sendReply({ result: res });
            return;
          }
          if (m.method === 'Runtime.callFunctionOn') {
            const params = { ...(m.params ?? {}) };
            if (
              typeof params.executionContextId === 'number' &&
              ctxAlias.has(params.executionContextId)
            ) {
              params.executionContextId = ctxAlias.get(params.executionContextId);
            }
            const res = (await v8.post(
              'Runtime.callFunctionOn',
              params as never,
            )) as unknown as Record<string, unknown>;
            if (holdNextV8Reply) {
              const hook = holdNextV8Reply;
              holdNextV8Reply = undefined;
              hook(() => sendReply({ result: res }), res);
              return;
            }
            sendReply({ result: res });
            return;
          }
          if (m.method === 'Runtime.releaseObjectGroup') {
            await v8.post('Runtime.releaseObjectGroup', (m.params ?? {}) as never);
            sendReply({ result: {} });
            return;
          }
          if (m.method === 'Runtime.releaseObject') {
            releasedObjectIds.push(String(m.params?.objectId ?? ''));
            await v8.post('Runtime.releaseObject', (m.params ?? {}) as never);
            sendReply({ result: {} });
            return;
          }
          sendReply({ error: { code: -32601, message: `Unsupported method: ${m.method}` } });
        } catch (err) {
          sendReply({
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          });
        }
      })();
    },
    close() {},
  };

  const connection = new Connection(transport);
  try {
    const s = await connection.attachSession('v8-tab');
    const wNone = createIsolatedWorld(s, {
      scope: 'target',
      verification: 'none',
      worldName: 'v8-none',
    });
    const wGuard = createIsolatedWorld(s, {
      scope: 'target',
      verification: 'guard',
      worldName: 'v8-guard',
    });
    const wStrict = createIsolatedWorld(s, {
      scope: 'session',
      verification: 'strict',
      worldName: 'v8-strict',
    });

    // 1. Pure expressions, explicit strict & default non-strict semantics, unshadowed global `ok`, and side-effect rejection in ALL modes on real V8!
    for (const [name, world] of [
      ['none', wNone],
      ['guard', wGuard],
      ['strict', wStrict],
    ] as const) {
      expect(await world.evaluate('1+1', undefined, { throwOnSideEffect: true })).toBe(2);
      expect(
        await world.evaluate('(() => { const x = 1; return x + 2; })()', undefined, {
          throwOnSideEffect: true,
        }),
      ).toBe(3);
      // Preserves BOTH default non-strict AND explicit "use strict" / 'use strict' directive semantics under throwOnSideEffect: true!
      expect(
        await world.evaluate('(function(){return this === globalThis})()', undefined, {
          throwOnSideEffect: true,
        }),
      ).toBe(true);
      expect(
        await world.evaluate('"use strict"; (function(){return this === undefined})()', undefined, {
          throwOnSideEffect: true,
        }),
      ).toBe(true);
      expect(
        await world.evaluate(
          '#!/usr/bin/env node\n"use strict"; (function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '#!/usr/bin/env node\n(function(){return this === globalThis})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '<!-- banner\n"use strict"; (function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '/* lead */ --> banner\n"use strict"; (function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '/* comment */\n"other"; \'use strict\'; (function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      await world.evaluate('globalThis.index = 1');
      expect(
        await world.evaluate(
          '"use strict"\nin\\u0064ex; (function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '"use strict"\nin\\u{64}ex; (function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate('"use strict"\nin ({})', undefined, { throwOnSideEffect: true }),
      ).toBe(false);
      // Distinguish newline + numeric literal `.5` (triggers ASI -> strict) from newline + member access `.length` (continues expression -> non-strict)!
      expect(
        await world.evaluate(
          '"use strict"\n.5;\n(function(){return this === undefined})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '"use strict"\n.length;\n(function(){return this === globalThis})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '"foo"\n.5;\n"use strict";\n(function(){return this === globalThis})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate(
          '"use\\x20strict"; (function(){return this === globalThis})()',
          undefined,
          { throwOnSideEffect: true },
        ),
      ).toBe(true);
      expect(
        await world.evaluate('"use strict".length', undefined, { throwOnSideEffect: true }),
      ).toBe(10);
      expect(await world.evaluate((a: number) => a + 1, 41, { throwOnSideEffect: true })).toBe(42);
      // Guard wrapper introduces zero shadowed local identifiers (e.g. globalThis.ok = 9)!
      await world.evaluate('globalThis.ok = 9');
      expect(
        await world.evaluate(() => (globalThis as unknown as { ok: number }).ok, undefined),
      ).toBe(9);
      expect(await world.evaluate(new Function('return ok') as () => number)).toBe(9);
      expect(
        await world.evaluate(new Function('return ok') as () => number, undefined, {
          disableBreaks: true,
          throwOnSideEffect: true,
        }),
      ).toBe(9);
      // Side-effecting code is genuinely rejected by V8!
      await expect(
        world.evaluate(`globalThis.__nd_se_${name}__ = 1`, undefined, { throwOnSideEffect: true }),
      ).rejects.toBeInstanceOf(EvaluationError);
      expect(await world.evaluate(`"__nd_se_${name}__" in globalThis`)).toBe(false);
    }

    // Guard mismatch under throwOnSideEffect: true rejects with isContextGone(err) === true!
    const guardCtxId = worldContexts.get('v8-guard')!;
    const swappedRealCtxId = createRealVmContext('nd-v8-swapped-main');
    ctxAlias.set(guardCtxId, swappedRealCtxId);
    const mismatchErr = await wGuard
      .evaluate('1+1', undefined, { throwOnSideEffect: true, retryOnContextGone: false })
      .catch((e) => e);
    expect(isContextGone(mismatchErr)).toBe(true);
    ctxAlias.delete(guardCtxId);

    // 2. Sparse arrays, custom toJSON(key), and special values match Runtime.callFunctionOn identically across ALL paths!
    const inspectArg = (arg: unknown) => {
      if (Array.isArray(arg)) {
        return {
          kind: 'array',
          length: arg.length,
          present: Array.from({ length: arg.length }, (_, i) => i in arg),
          values: arg,
        };
      }
      if (typeof arg === 'bigint') return { kind: 'bigint', value: arg.toString() };
      if (typeof arg === 'number') {
        return {
          kind: 'number',
          isNaN: Number.isNaN(arg),
          isNegZero: Object.is(arg, -0),
          str: String(arg),
        };
      }
      return { kind: typeof arg, value: arg };
    };

    const samples: unknown[] = [
      Array(1),
      [1, , 3, ,],
      [undefined],
      { a: 1, b: undefined, c: Number.NaN, d: -0, sparse: Array(2) },
      {
        toJSON(key: string) {
          return `key=${key}`;
        },
      },
      {
        toJSON() {
          return undefined;
        },
      },
      new Date('2026-01-01T00:00:00.000Z'),
      42n,
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      undefined,
    ];

    for (const sample of samples) {
      // Baseline: native CDP Runtime.callFunctionOn (strict default)
      const baseline = await wStrict.evaluate(inspectArg, sample);
      // Compare against Runtime.evaluate paths: guard, strict+disableBreaks, none+disableBreaks, guard+throwOnSideEffect
      expect(await wGuard.evaluate(inspectArg, sample)).toEqual(baseline);
      expect(await wStrict.evaluate(inspectArg, sample, { disableBreaks: false })).toEqual(
        baseline,
      );
      expect(await wNone.evaluate(inspectArg, sample, { disableBreaks: false })).toEqual(baseline);
      expect(await wGuard.evaluate(inspectArg, sample, { throwOnSideEffect: true })).toEqual(
        baseline,
      );
    }

    // 3. Normal AND late real-V8 exception replies release BOTH result.objectId AND exceptionDetails.exception.objectId!
    const assertHandleGoneInV8 = async (objectId: string) => {
      await expect(
        v8.post('Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){return 1}',
          returnByValue: true,
        }),
      ).rejects.toThrow(/Could not find object with given id/);
    };

    // 3a. Normal (non-late) exception releases BOTH distinct V8 remote handles
    {
      let normalResultObjectId = '';
      let normalExceptionObjectId = '';
      holdNextV8Reply = (deliver, res) => {
        normalResultObjectId = String(
          (res.result as { objectId?: string } | undefined)?.objectId ?? '',
        );
        const details = res.exceptionDetails as { exception?: { objectId?: string } } | undefined;
        normalExceptionObjectId = String(details?.exception?.objectId ?? '');
        deliver();
      };
      await expect(
        wGuard.evaluate('(() => { throw new Error("normal-dual-handle"); })()'),
      ).rejects.toBeInstanceOf(EvaluationError);
      await connection.drain();
      expect(normalResultObjectId.length).toBeGreaterThan(0);
      expect(normalExceptionObjectId.length).toBeGreaterThan(0);
      expect(normalResultObjectId).not.toBe(normalExceptionObjectId);
      expect(releasedObjectIds).toContain(normalResultObjectId);
      expect(releasedObjectIds).toContain(normalExceptionObjectId);
      await assertHandleGoneInV8(normalResultObjectId);
      await assertHandleGoneInV8(normalExceptionObjectId);
    }

    // 3b. Late exception after dispose() releases BOTH distinct V8 remote handles
    {
      let deliverLate!: () => void;
      let lateResultObjectId = '';
      let lateExceptionObjectId = '';
      holdNextV8Reply = (deliver, res) => {
        deliverLate = deliver;
        lateResultObjectId = String(
          (res.result as { objectId?: string } | undefined)?.objectId ?? '',
        );
        const details = res.exceptionDetails as { exception?: { objectId?: string } } | undefined;
        lateExceptionObjectId = String(details?.exception?.objectId ?? '');
      };
      const disposedEval = wGuard
        .evaluate('(() => { throw new Error("late-dispose"); })()')
        .catch((e) => e);
      await new Promise((r) => setTimeout(r, 15));
      expect(typeof deliverLate).toBe('function');
      expect(lateResultObjectId.length).toBeGreaterThan(0);
      expect(lateExceptionObjectId.length).toBeGreaterThan(0);
      expect(lateResultObjectId).not.toBe(lateExceptionObjectId);
      wGuard.dispose();
      expect(await disposedEval).toBeInstanceOf(StaleElementError);
      expect(releasedObjectIds).not.toContain(lateResultObjectId);
      expect(releasedObjectIds).not.toContain(lateExceptionObjectId);
      deliverLate();
      await connection.drain();
      expect(releasedObjectIds).toContain(lateResultObjectId);
      expect(releasedObjectIds).toContain(lateExceptionObjectId);
      await assertHandleGoneInV8(lateResultObjectId);
      await assertHandleGoneInV8(lateExceptionObjectId);
    }

    // 3c. Late exception after AbortSignal cancellation releases BOTH distinct V8 remote handles on Runtime.callFunctionOn (strict)!
    {
      const ctrl = new AbortController();
      let deliverLate!: () => void;
      let lateResultObjectId = '';
      let lateExceptionObjectId = '';
      holdNextV8Reply = (deliver, res) => {
        deliverLate = deliver;
        lateResultObjectId = String(
          (res.result as { objectId?: string } | undefined)?.objectId ?? '',
        );
        const details = res.exceptionDetails as { exception?: { objectId?: string } } | undefined;
        lateExceptionObjectId = String(details?.exception?.objectId ?? '');
      };
      const abortedEval = wStrict
        .evaluate('(() => { throw new Error("late-abort"); })()', undefined, {
          signal: ctrl.signal,
        })
        .catch((e) => e);
      await new Promise((r) => setTimeout(r, 15));
      expect(typeof deliverLate).toBe('function');
      expect(lateResultObjectId.length).toBeGreaterThan(0);
      expect(lateExceptionObjectId.length).toBeGreaterThan(0);
      expect(lateResultObjectId).not.toBe(lateExceptionObjectId);
      ctrl.abort(new Error('caller-cancelled'));
      const abortErr = await abortedEval;
      expect(abortErr).toBeInstanceOf(Error);
      expect((abortErr as Error).message).toBe('caller-cancelled');
      deliverLate();
      await connection.drain();
      expect(releasedObjectIds).toContain(lateResultObjectId);
      expect(releasedObjectIds).toContain(lateExceptionObjectId);
      await assertHandleGoneInV8(lateResultObjectId);
      await assertHandleGoneInV8(lateExceptionObjectId);
    }

    // Strict-mode in-flight evaluate() (Runtime.callFunctionOn) also settles immediately on dispose()!
    {
      let deliverStrict!: () => void;
      holdNextV8Reply = (deliver) => {
        deliverStrict = deliver;
      };
      let strictSettled = false;
      const strictEvalPromise = wStrict.evaluate('1 + 1').then(
        (v) => {
          strictSettled = true;
          return v;
        },
        (e) => {
          strictSettled = true;
          return e;
        },
      );
      await new Promise((r) => setTimeout(r, 15));
      expect(strictSettled).toBe(false);
      expect(typeof deliverStrict).toBe('function');
      wStrict.dispose();
      expect(await strictEvalPromise).toBeInstanceOf(StaleElementError);
      deliverStrict();
      await connection.drain();
    }

    await s.detach();
  } finally {
    await connection.close();
    v8.disconnect();
  }
});
