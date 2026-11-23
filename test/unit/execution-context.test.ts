import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Connection, TargetSession } from '../../src/protocol/connection.ts';
import { Frame, type FrameManager } from '../../src/page/frames.ts';
import { parseRemoteObjectId, resolveMainContext } from '../../src/page/execution-context.ts';
import {
  createIsolatedWorld,
  DisconnectedError,
  evaluateIsolated,
  EvaluationError,
  isContextGone,
  ProtocolError,
  SessionEndedError,
  StaleElementError,
  TimeoutError,
  UnsupportedError,
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
