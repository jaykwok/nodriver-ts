import assert from 'node:assert/strict';
import inspector from 'node:inspector';
import { test } from 'node:test';
import vm from 'node:vm';
import type { Protocol } from 'devtools-protocol';
import {
  DisconnectedError,
  EvaluationError,
  IsolatedWorld,
  IsolatedWorldPool,
  ObjectGroupScope,
  ProtocolError,
  StaleElementError,
  TimeoutError,
  createIsolatedWorld,
  createIsolatedWorldPool,
  createObjectGroup,
  evaluateAcrossFrames,
  getNodeEventListeners,
  parseDOMSnapshot,
  setWindowState,
} from '../../src/index.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';

function forbidEnable(method: string): void {
  if (/^(DOM|Runtime|Page|Debugger)\.enable$/.test(method))
    throw new Error(`Forbidden CDP enable command: ${method}`);
}

test('1. ObjectGroupScope, createObjectGroup, and IsolatedWorld.withObjectGroup release reliably', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://raw.test/' }] });
  let nextContext = 10;
  let globalCounter = 0;
  const releasedGroups: string[] = [];
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: ++nextContext }));
  chrome.handle('Runtime.evaluate', (params) => {
    if (params.expression === 'globalThis') {
      return {
        result: {
          type: 'object',
          objectId: `1.${params.contextId}.${++globalCounter}`,
        },
      };
    }
    return { result: { type: 'object', value: true } };
  });
  chrome.handle('Runtime.callFunctionOn', (params) => {
    if (
      params.functionDeclaration ===
      'function(k,t){var d=Object.getOwnPropertyDescriptor(this,k);if(d&&typeof d.value==="string"&&d.value.startsWith("ndg:")&&!d.configurable&&!d.writable)return d.value;Object.defineProperty(this,k,{value:t,enumerable:false,configurable:false,writable:false});return t}'
    ) {
      return { result: { type: 'string', value: params.arguments?.[1]?.value } };
    }
    return { result: { type: 'boolean', value: true } };
  });
  let releaseDelayGate: Promise<void> | undefined;
  chrome.handle('Runtime.releaseObjectGroup', async (params) => {
    releasedGroups.push(params.objectGroup);
    if (releaseDelayGate) await releaseDelayGate;
  });

  await using browser = await chrome.connect({ attach: 'none', beforeSend: forbidEnable });
  const targetId = browser.pageTargets[0]!.targetId;
  const session = await browser.attachSession(targetId);

  // Validation: empty group name throws TypeError.
  assert.throws(() => createObjectGroup(session, ''), TypeError);
  assert.throws(() => new ObjectGroupScope(session, ''), TypeError);

  // await using releases automatically and release() is idempotent.
  let usedName = '';
  {
    await using scope = createObjectGroup(session, 'custom-group-1');
    usedName = scope.name;
    assert.equal(scope.released, false);
    assert.equal(scope.name, 'custom-group-1');
  }
  assert.deepEqual(releasedGroups, [usedName]);

  const manual = createObjectGroup(session);
  assert.ok(manual.name.startsWith('nodriver-group-'));
  await manual.release();
  await manual.release();
  assert.equal(manual.released, true);
  assert.equal(releasedGroups.filter((g) => g === manual.name).length, 1);

  // Regression (P2): pre-aborted release() rejects without marking released=true or sending CDP,
  // allowing a subsequent release() to send Runtime.releaseObjectGroup and confirm cleanup.
  const preAborted = createObjectGroup(session, 'pre-abort-group');
  const sentBeforePreAbort = releasedGroups.length;
  await assert.rejects(
    preAborted.release({ signal: AbortSignal.abort(new Error('cancel release')) }),
    /cancel release/,
  );
  assert.equal(preAborted.released, false);
  assert.equal(releasedGroups.length, sentBeforePreAbort);
  await preAborted.release();
  assert.equal(preAborted.released, true);
  assert.equal(releasedGroups.filter((g) => g === 'pre-abort-group').length, 1);

  // Regression (P2): timed-out release() keeps released=false until late confirmation arrives.
  let finishDelayedRelease!: () => void;
  releaseDelayGate = new Promise<void>((r) => {
    finishDelayedRelease = r;
  });
  const delayed = createObjectGroup(session, 'delayed-group');
  await assert.rejects(delayed.release({ timeout: 25 }), TimeoutError);
  assert.equal(delayed.released, false);
  finishDelayedRelease();
  releaseDelayGate = undefined;
  await browser.drain();
  assert.equal(delayed.released, true);
  // Already confirmed via late reply -> subsequent release() is a no-op.
  const delayedCount = releasedGroups.filter((g) => g === 'delayed-group').length;
  await delayed.release();
  assert.equal(releasedGroups.filter((g) => g === 'delayed-group').length, delayedCount);

  // Regression (P2): aborting caller A's release({ signal }) while in flight must NOT abort
  // concurrent caller B's independent wait on the same ObjectGroupScope.
  let finishSharedRelease!: () => void;
  releaseDelayGate = new Promise<void>((r) => {
    finishSharedRelease = r;
  });
  const sharedGroup = createObjectGroup(session, 'shared-release-group');
  const acA = new AbortController();
  const waitA = sharedGroup.release({ signal: acA.signal }).catch((e: unknown) => e);
  const waitB = sharedGroup.release({ timeout: 500 });
  await new Promise((r) => setTimeout(r, 15));
  acA.abort(new Error('cancel caller A'));
  const errA = await waitA;
  assert.match(String(errA), /cancel caller A/);
  assert.equal(sharedGroup.released, false);
  // Release server gate: caller B still resolves cleanly and only 1 wire command was sent!
  finishSharedRelease();
  releaseDelayGate = undefined;
  await waitB;
  assert.equal(sharedGroup.released, true);
  assert.equal(releasedGroups.filter((g) => g === 'shared-release-group').length, 1);

  // IsolatedWorld.withObjectGroup: normal completion, error, context-gone retry, and hung timeout.
  const world = createIsolatedWorld(session, {
    worldName: 'wg-test',
    verification: 'none',
  });
  await assert.rejects(
    world.withObjectGroup(async () => 1, { objectGroup: '' }),
    TypeError,
  );

  let okGroup = '';
  const val = await world.withObjectGroup(async (scope, contextId) => {
    okGroup = scope.name;
    assert.ok(contextId > 10);
    return 'done';
  });
  await browser.drain();
  assert.equal(val, 'done');
  assert.ok(releasedGroups.includes(okGroup));

  let errGroup = '';
  await assert.rejects(
    world.withObjectGroup(async (scope) => {
      errGroup = scope.name;
      throw new Error('boom');
    }),
    /boom/,
  );
  await browser.drain();
  assert.ok(releasedGroups.includes(errGroup));

  // Retry on context gone releases BOTH attempt 0's group and attempt 1's group.
  const retryGroups: string[] = [];
  const contexts: number[] = [];
  let failOnce = true;
  const retried = await world.withObjectGroup(async (scope, contextId) => {
    retryGroups.push(scope.name);
    contexts.push(contextId);
    if (failOnce) {
      failOnce = false;
      throw new ProtocolError('DOM.resolveNode', -32000, 'Cannot find context with specified id');
    }
    return 'recovered';
  });
  await browser.drain();
  assert.equal(retried, 'recovered');
  assert.equal(retryGroups.length, 2);
  assert.notEqual(contexts[0], contexts[1]);
  assert.ok(releasedGroups.includes(retryGroups[0]!));
  assert.ok(releasedGroups.includes(retryGroups[1]!));

  // Hung task timed out by withObjectGroup still releases its object group promptly.
  let hungGroup = '';
  await assert.rejects(
    world.withObjectGroup(
      async (scope) => {
        hungGroup = scope.name;
        await new Promise(() => {});
      },
      { timeout: 40 },
    ),
    TimeoutError,
  );
  await browser.drain();
  assert.ok(releasedGroups.includes(hungGroup));

  // Release on already-closed session sends zero CDP commands.
  await session.detach();
  const countBefore = releasedGroups.length;
  const afterClose = createObjectGroup(session, 'closed-group');
  await afterClose.release();
  assert.equal(afterClose.released, true);
  assert.equal(releasedGroups.length, countBefore);
});

test('1b. ObjectGroupScope.release wakes active waiters on late confirmation, enforces 1s default with signal-only, and deduplicates onSend reentrancy', async () => {
  // 1) Regression (P2): late confirmation from attempt 1 wakes an active waiter on attempt 2.
  {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://late-rel.test/' }] });
    let releaseCallNum = 0;
    let releaseFirstReply!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirstReply = r;
    });
    let secondArrived!: () => void;
    const waitSecond = new Promise<void>((r) => {
      secondArrived = r;
    });
    chrome.handle('Runtime.releaseObjectGroup', async () => {
      releaseCallNum++;
      if (releaseCallNum === 1) {
        await firstGate;
        return;
      }
      secondArrived();
      // Attempt 2 never answers on its own; attempt 1's late reply must wake attempt 2!
      return NO_REPLY;
    });
    await using browser = await chrome.connect({ attach: 'none', timeout: 150 });
    const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
    const group = createObjectGroup(session, 'late-wake-group');
    // Attempt 1 times out at the connection's 150 ms command timeout.
    await assert.rejects(group.release({ timeout: 650 }), TimeoutError);
    assert.equal(group.released, false);
    // Start attempt 2; once on the wire, let attempt 1's late OK reply arrive.
    const secondStarted = performance.now();
    const attempt2 = group.release({ timeout: 650 });
    await waitSecond;
    releaseFirstReply();
    await attempt2;
    assert.equal(group.released, true);
    assert.ok(
      performance.now() - secondStarted < 140,
      'attempt 2 must wake immediately on attempt 1 late confirmation instead of timing out',
    );
  }

  // 2) Regression (P2): passing only `{ signal }` still applies the default 1 s timeout.
  {
    await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://sig-rel.test/' }] });
    chrome.handle('Runtime.releaseObjectGroup', async () => {
      await new Promise((r) => setTimeout(r, 1250));
    });
    await using browser = await chrome.connect({ attach: 'none', timeout: 5000 });
    const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
    const group = createObjectGroup(session, 'signal-only-group');
    const ac = new AbortController();
    const started = performance.now();
    await assert.rejects(group.release({ signal: ac.signal }), TimeoutError);
    const elapsed = performance.now() - started;
    assert.ok(
      elapsed >= 900 && elapsed < 1200,
      `expected default 1 s timeout for signal-only release(), got ${elapsed}ms`,
    );
    assert.equal(group.released, false);
    // Wait for the late 1250 ms reply to confirm cleanup cleanly.
    await browser.drain();
    assert.equal(group.released, true);
  }

  // 3) Regression (P3): synchronous reentrancy from `observe.onSend` sends strictly 1 command.
  {
    await using chrome = await ScriptedChrome.start({
      pages: [{ url: 'https://reent-rel.test/' }],
    });
    let releaseSentCount = 0;
    chrome.handle('Runtime.releaseObjectGroup', () => {
      releaseSentCount++;
    });
    let reentrantScope: ObjectGroupScope | undefined;
    let reentrantPromise: Promise<void> | undefined;
    let reentered = false;
    await using browser = await chrome.connect({
      attach: 'none',
      observe: {
        onSend(ev) {
          if (ev.method === 'Runtime.releaseObjectGroup' && reentrantScope && !reentered) {
            reentered = true;
            reentrantPromise = reentrantScope.release();
          }
        },
      },
    });
    const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
    reentrantScope = createObjectGroup(session, 'reentrant-group');
    await reentrantScope.release();
    assert.equal(reentered, true);
    assert.ok(reentrantPromise);
    await reentrantPromise;
    await browser.drain();
    assert.equal(reentrantScope.released, true);
    assert.equal(
      releaseSentCount,
      1,
      'synchronous reentrant release() inside onSend must share the single wire command',
    );
  }

  // 4) Regression (P2 + P3): beforeSend throwing DisconnectedError or `undefined` while the
  // session stays open must reject with the original reason, keep released=false, send 0 commands,
  // and allow a subsequent release() to succeed once beforeSend stops blocking.
  {
    await using chrome = await ScriptedChrome.start({
      pages: [{ url: 'https://guard-rel.test/' }],
    });
    let releaseSentCount = 0;
    chrome.handle('Runtime.releaseObjectGroup', () => {
      releaseSentCount++;
    });
    let blockMode: 'none' | 'disconnected' | 'undefined' = 'disconnected';
    await using browser = await chrome.connect({
      attach: 'none',
      beforeSend(method) {
        if (method !== 'Runtime.releaseObjectGroup') return;
        if (blockMode === 'disconnected') throw new DisconnectedError('blocked by beforeSend');
        if (blockMode === 'undefined') throw undefined;
      },
    });
    const session = await browser.attachSession(browser.pageTargets[0]!.targetId);
    const group = createObjectGroup(session, 'before-send-group');

    // beforeSend throws DisconnectedError while session is open -> rejects, released stays false.
    await assert.rejects(group.release(), (error: unknown) => {
      assert.ok(error instanceof DisconnectedError);
      assert.match(error.message, /blocked by beforeSend/);
      return true;
    });
    assert.equal(group.released, false);
    assert.equal(releaseSentCount, 0);

    // beforeSend throws `undefined` -> rejects with `undefined`, NOT resolving!
    blockMode = 'undefined';
    let rejectedUndefined = false;
    let rejectionValue: unknown = 'NOT_REJECTED';
    try {
      await group.release();
    } catch (reason) {
      rejectedUndefined = true;
      rejectionValue = reason;
    }
    assert.equal(rejectedUndefined, true);
    assert.equal(rejectionValue, undefined);
    assert.equal(group.released, false);
    assert.equal(releaseSentCount, 0);

    // Once beforeSend allows sending, retry succeeds and confirms released=true.
    blockMode = 'none';
    await group.release();
    assert.equal(group.released, true);
    assert.equal(releaseSentCount, 1);
  }
});

test('2. IsolatedWorld.callOnNodes handles strict/guard/none, chunking, missing/disconnected nodes, late cleanup, and V8 side-effect checks', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://nodes.test/' }] });
  let nextContext = 100;
  let seq = 0;
  const worldTokens = new Map<number, string>();
  const validContextIds = new Set<number>();
  const fakeElements = new Map<
    number,
    { backendNodeId: number; tag: string; isConnected: boolean; missing?: boolean }
  >([
    [1, { backendNodeId: 1, tag: 'BUTTON', isConnected: true }],
    [2, { backendNodeId: 2, tag: 'INPUT', isConnected: false }],
    [3, { backendNodeId: 3, tag: 'A', isConnected: true, missing: true }],
    [4, { backendNodeId: 4, tag: 'DIV', isConnected: true }],
    [5, { backendNodeId: 5, tag: 'SPAN', isConnected: true }],
  ]);

  const objectsByGroup = new Map<string, Set<string>>();
  const objectTable = new Map<string, { value: unknown; group: string; contextId: number }>();
  const releasedGroups: string[] = [];
  const releasedObjects: string[] = [];
  const callFnParamsLog: Protocol.Runtime.CallFunctionOnRequest[] = [];

  const bindObj = (contextId: number, group: string, value: unknown): string => {
    const id = `1.${contextId}.${++seq}`;
    objectTable.set(id, { value, group, contextId });
    let set = objectsByGroup.get(group);
    if (!set) objectsByGroup.set(group, (set = new Set()));
    set.add(id);
    return id;
  };

  const worldContexts = new Map<string, number>();
  let currentWorldGlobal: Record<string, unknown> = {};
  const createWorldGlobal = (contextId: number) => {
    const g: Record<string, unknown> = {
      Object,
      document: { __doc: true, frameId: targetId },
    };
    g.globalThis = g;
    currentWorldGlobal = g;
    return g;
  };

  let targetId = '';
  let resolveGate: Promise<void> | undefined;
  let resolveArrived: (() => void) | undefined;

  chrome.handle('Page.createIsolatedWorld', (params) => {
    const key = params.worldName ?? '';
    const existing = worldContexts.get(key);
    if (existing !== undefined) return { executionContextId: existing };
    const ctx = ++nextContext;
    worldContexts.set(key, ctx);
    validContextIds.add(ctx);
    createWorldGlobal(ctx);
    return { executionContextId: ctx };
  });
  chrome.handle('Runtime.evaluate', (params) => {
    const ctx = params.contextId!;
    if (!validContextIds.has(ctx))
      throw new ProtocolError('Runtime.evaluate', -32000, 'Cannot find context with specified id');
    if (params.expression === 'globalThis') {
      const id = bindObj(ctx, params.objectGroup ?? 'default', currentWorldGlobal);
      return { result: { type: 'object', objectId: id } };
    }
    return { result: { type: 'undefined' } };
  });
  chrome.handle('DOM.describeNode', () => ({
    node: {
      nodeId: 1,
      backendNodeId: 9001,
      nodeType: 9,
      nodeName: '#document',
      localName: '',
      nodeValue: '',
      frameId: targetId,
    },
  }));
  let destroyOnResolveNodeId: number | undefined;
  let destroyAfterCallFnExec = false;
  let stallCallFnAndRelease = false;
  chrome.handle('DOM.resolveNode', async (params) => {
    const p = params!;
    if (p.backendNodeId === 9001) {
      // Main world doc (ctx 1) vs isolated world doc (executionContextId)
      const ctx = p.executionContextId ?? 1;
      const id = bindObj(ctx, p.objectGroup ?? 'default', currentWorldGlobal.document);
      return { object: { type: 'object', objectId: id } };
    }
    if (destroyOnResolveNodeId !== undefined && p.backendNodeId === destroyOnResolveNodeId) {
      destroyOnResolveNodeId = undefined;
      worldContexts.delete('none-world');
      throw new ProtocolError('DOM.resolveNode', -32000, 'Execution context was destroyed');
    }
    const el = fakeElements.get(p.backendNodeId!);
    if (resolveGate) {
      resolveArrived?.();
      await resolveGate;
    }
    if (!el || el.missing)
      throw new ProtocolError('DOM.resolveNode', -32000, 'No node with given id found');
    const ctx = p.executionContextId ?? 1;
    const id = bindObj(ctx, p.objectGroup ?? 'default', el);
    return { object: { type: 'object', objectId: id } };
  });
  chrome.handle('Runtime.releaseObjectGroup', (params) => {
    releasedGroups.push(params.objectGroup);
    if (stallCallFnAndRelease) return NO_REPLY;
    const set = objectsByGroup.get(params.objectGroup);
    if (set) {
      for (const id of set) objectTable.delete(id);
      objectsByGroup.delete(params.objectGroup);
    }
  });
  chrome.handle('Runtime.releaseObject', (params) => {
    releasedObjects.push(params.objectId);
    objectTable.delete(params.objectId);
  });
  chrome.handle('Runtime.callFunctionOn', (params) => {
    callFnParamsLog.push(params);
    if (stallCallFnAndRelease) return NO_REPLY;
    const code = params.functionDeclaration;
    if (code === 'function(){return this.document}') {
      const rec = objectTable.get(params.objectId!)!;
      const id = bindObj(
        rec.contextId,
        params.objectGroup ?? rec.group,
        currentWorldGlobal.document,
      );
      return { result: { type: 'object', objectId: id } };
    }
    if (code === 'function(other){return this === other}') {
      return { result: { type: 'boolean', value: true } };
    }
    const ctx = params.objectId
      ? objectTable.get(params.objectId)?.contextId
      : params.executionContextId;
    if (!ctx || !validContextIds.has(ctx))
      throw new ProtocolError(
        'Runtime.callFunctionOn',
        -32000,
        'Cannot find context with specified id',
      );
    const recv = params.objectId ? objectTable.get(params.objectId)?.value : currentWorldGlobal;
    const args = (params.arguments ?? []).map((a) =>
      a.objectId ? objectTable.get(a.objectId)?.value : a.value,
    );
    const sandbox = vm.createContext({
      globalThis: currentWorldGlobal,
      Object,
      Promise,
      TypeError,
    });
    let value: unknown;
    try {
      const fn = vm.runInContext(`(${code})`, sandbox) as (...a: unknown[]) => unknown;
      value = fn.apply(recv, args);
    } catch (error) {
      const text = typeof error === 'string' ? error : String(error);
      return {
        result: { type: 'undefined' },
        exceptionDetails: {
          exceptionId: 1,
          text: 'Uncaught',
          lineNumber: 0,
          columnNumber: 0,
          exception: { type: 'string', value: text, description: text },
        },
      };
    }
    if (destroyAfterCallFnExec && code.includes('__nd_fn')) {
      destroyAfterCallFnExec = false;
      worldContexts.delete('none-world');
      throw new ProtocolError('Runtime.callFunctionOn', -32000, 'Execution context was destroyed');
    }
    if (typeof value === 'string' && value.startsWith('ndg:')) worldTokens.set(ctx, value);
    return { result: { type: typeof value === 'object' ? 'object' : typeof value, value } };
  });

  await using browser = await chrome.connect({ attach: 'none', beforeSend: forbidEnable });
  targetId = browser.pageTargets[0]!.targetId;
  const session = await browser.attachSession(targetId);

  // Strict verification mode + chunking (5 nodes, chunkSize: 2 -> 3 chunks) + options forwarding.
  const strictWorld = createIsolatedWorld(session, {
    worldName: 'strict-world',
    verification: 'strict',
  });
  assert.deepEqual(await strictWorld.callOnNodes([], (el) => el.tagName), []);
  await assert.rejects(
    strictWorld.callOnNodes([0], (el) => el.tagName),
    RangeError,
  );
  await assert.rejects(
    strictWorld.callOnNodes([1], (el) => el.tagName, undefined, { chunkSize: 0 }),
    RangeError,
  );

  const beforeStrictCalls = callFnParamsLog.length;
  const beforeStrictGroups = releasedGroups.length;
  const strictResults = await strictWorld.callOnNodes(
    [1, 2, 3, 4, 5],
    (el, prefix) => `${prefix}:${(el as unknown as { tag: string }).tag}`,
    'strict',
    { chunkSize: 2, silent: true, throwOnSideEffect: true, userGesture: false },
  );
  assert.deepEqual(strictResults, [
    { ok: true, backendNodeId: 1, value: 'strict:BUTTON' },
    { ok: false, backendNodeId: 2, stale: true },
    { ok: false, backendNodeId: 3, stale: true },
    { ok: true, backendNodeId: 4, value: 'strict:DIV' },
    { ok: true, backendNodeId: 5, value: 'strict:SPAN' },
  ]);
  const batchCalls = callFnParamsLog
    .slice(beforeStrictCalls)
    .filter((p) => p.functionDeclaration.includes('__nd_fn'));
  assert.equal(batchCalls.length, 3);
  for (const call of batchCalls) {
    assert.ok(call.objectId, 'strict mode binds to globalThis objectId');
    assert.ok(call.objectGroup?.startsWith('nodriver-group-'), 'explicit chunk objectGroup');
    assert.equal(call.silent, true);
    assert.equal(call.throwOnSideEffect, true);
    assert.equal(call.userGesture, false);
  }
  await browser.drain();
  // All 3 chunk object groups were released.
  assert.ok(releasedGroups.length - beforeStrictGroups >= 3);

  // Regression (P2): async functions and Promise-returning callbacks are rejected at compile-time
  // AND runtime with TypeError instead of silently returning `{ ok: true, value: {} }`.
  const commandsBeforeAsync = chrome.commands.length;
  await assert.rejects(
    // @ts-expect-error callOnNodes rejects async callbacks at the type level too
    strictWorld.callOnNodes([1], async (el) => (el as unknown as { tag: string }).tag),
    TypeError,
  );
  assert.equal(chrome.commands.length, commandsBeforeAsync, 'async fn rejected before any CDP');
  await assert.rejects(
    // @ts-expect-error callOnNodes rejects Promise-returning callbacks at the type level too
    strictWorld.callOnNodes([1], (el) => Promise.resolve((el as unknown as { tag: string }).tag)),
    TypeError,
  );

  // requireConnected: false executes fn on disconnected node 2 as well.
  const includeDisconnected = await strictWorld.callOnNodes(
    [1, 2],
    (el) => (el as unknown as { tag: string }).tag,
    undefined,
    { requireConnected: false },
  );
  assert.deepEqual(includeDisconnected, [
    { ok: true, backendNodeId: 1, value: 'BUTTON' },
    { ok: true, backendNodeId: 2, value: 'INPUT' },
  ]);

  // skipMissingNodes: false rejects with StaleElementError (ProtocolError cause).
  await assert.rejects(
    strictWorld.callOnNodes([1, 3], (el) => (el as unknown as { tag: string }).tag, undefined, {
      skipMissingNodes: false,
    }),
    (error: unknown) => {
      assert.ok(error instanceof StaleElementError);
      assert.ok(error.cause instanceof ProtocolError);
      return true;
    },
  );

  // Guard verification mode: detects tampered/wrong-world guard token, rebuilds world & retries once.
  const guardWorld = createIsolatedWorld(session, {
    worldName: 'guard-world',
    verification: 'guard',
  });
  const firstGuard = await guardWorld.callOnNodes(
    [4],
    (el) => (el as unknown as { tag: string }).tag,
  );
  assert.deepEqual(firstGuard, [{ ok: true, backendNodeId: 4, value: 'DIV' }]);
  // Simulate cross-process contextId reuse with a fresh global missing our guard token.
  worldContexts.delete('guard-world');
  currentWorldGlobal = { Object };
  currentWorldGlobal.globalThis = currentWorldGlobal;
  const recoveredGuard = await guardWorld.callOnNodes(
    [4],
    (el) => (el as unknown as { tag: string }).tag,
  );
  assert.deepEqual(recoveredGuard, [{ ok: true, backendNodeId: 4, value: 'DIV' }]);

  // Regression (P1): once chunk 0's user callback has executed, context loss on chunk 1 MUST NOT
  // replay chunk 0 or mix results across documents; the next call still rebuilds cleanly.
  const noneWorld = createIsolatedWorld(session, {
    worldName: 'none-world',
    verification: 'none',
  });
  await noneWorld.context();
  const invokedLog: number[] = [];
  currentWorldGlobal.__log = invokedLog;
  destroyOnResolveNodeId = 4;
  await assert.rejects(
    noneWorld.callOnNodes(
      [1, 4],
      (el) => {
        const id = (el as unknown as { backendNodeId: number }).backendNodeId;
        ((globalThis as unknown as { __log?: number[] }).__log ?? []).push(id);
        return id;
      },
      undefined,
      { chunkSize: 1 },
    ),
    (error: unknown) =>
      error instanceof ProtocolError && /Execution context was destroyed/.test(error.message),
  );
  assert.deepEqual(
    invokedLog,
    [1],
    'chunk 0 callback must run only once, never replayed as [1, 1, 4]',
  );
  // Subsequent call rebuilds the invalidated world cleanly.
  const afterRebuild = await noneWorld.callOnNodes(
    [4],
    (el) => (el as unknown as { tag: string }).tag,
  );
  assert.deepEqual(afterRebuild, [{ ok: true, backendNodeId: 4, value: 'DIV' }]);

  // Regression (P1, direction 1): chunk 0 executes user callback then Runtime.callFunctionOn fails
  // with `Execution context was destroyed` (uncertain outcome). MUST NOT replay chunk 0!
  const firstChunkLog: number[] = [];
  currentWorldGlobal.__log = firstChunkLog;
  destroyAfterCallFnExec = true;
  await assert.rejects(
    noneWorld.callOnNodes(
      [1],
      (el) => {
        const id = (el as unknown as { backendNodeId: number }).backendNodeId;
        ((globalThis as unknown as { __log?: number[] }).__log ?? []).push(id);
        return id;
      },
      undefined,
      { chunkSize: 1 },
    ),
    (error: unknown) =>
      error instanceof ProtocolError && /Execution context was destroyed/.test(error.message),
  );
  assert.deepEqual(
    firstChunkLog,
    [1],
    'uncertain chunk 0 failure must NOT replay user callback as [1, 1]',
  );

  // Regression (P1, direction 2): chunk 0 contains only detached nodes (confirmed 0 callback runs),
  // then chunk 1 hits `Execution context was destroyed` during DOM.resolveNode -> safe to rebuild
  // and retry from chunk 0!
  const detachedFirstLog: number[] = [];
  await noneWorld.context();
  currentWorldGlobal.__log = detachedFirstLog;
  destroyOnResolveNodeId = 4;
  const retriedAfterZeroRuns = await noneWorld.callOnNodes(
    [2, 4],
    (el) => {
      const id = (el as unknown as { backendNodeId: number }).backendNodeId;
      ((globalThis as unknown as { __log?: number[] }).__log ?? []).push(id);
      return (el as unknown as { tag: string }).tag;
    },
    undefined,
    { chunkSize: 1 },
  );
  assert.deepEqual(retriedAfterZeroRuns, [
    { ok: false, backendNodeId: 2, stale: true },
    { ok: true, backendNodeId: 4, value: 'DIV' },
  ]);
  assert.deepEqual(detachedFirstLog, []);

  // Verify skipMissingNodes: false still returns stale: true for resolved-but-disconnected nodes.
  const resolvedDisconnected = await noneWorld.callOnNodes(
    [1, 2],
    (el) => (el as unknown as { tag: string }).tag,
    undefined,
    { skipMissingNodes: false },
  );
  assert.deepEqual(resolvedDisconnected, [
    { ok: true, backendNodeId: 1, value: 'BUTTON' },
    { ok: false, backendNodeId: 2, stale: true },
  ]);

  // Late DOM.resolveNode reply after abort releases the late objectId before drain() resolves.
  let releaseResolve!: () => void;
  resolveGate = new Promise<void>((r) => {
    releaseResolve = r;
  });
  const waitArrived = new Promise<void>((r) => {
    resolveArrived = r;
  });
  const ac = new AbortController();
  const pendingCall = noneWorld
    .callOnNodes([1], (el) => (el as unknown as { tag: string }).tag, undefined, {
      signal: ac.signal,
    })
    .catch((e: unknown) => e);
  await waitArrived;
  ac.abort(new Error('cancel resolve'));
  const abortErr = await pendingCall;
  assert.match(String(abortErr), /cancel resolve/);
  const releasedBeforeLate = releasedObjects.length;
  releaseResolve();
  resolveGate = undefined;
  await browser.drain();
  assert.ok(
    releasedObjects.length > releasedBeforeLate,
    'late DOM.resolveNode objectId must be released via ON_LATE_REPLY',
  );

  // Regression (P2): callOnNodes chunk cleanup does NOT wait past caller timeout when
  // Runtime.releaseObjectGroup stalls; release is queued on the connection for drain().
  stallCallFnAndRelease = true;
  const groupsBeforeTimeout = releasedGroups.length;
  const timeoutStarted = performance.now();
  await assert.rejects(
    noneWorld.callOnNodes([1], (el) => (el as unknown as { tag: string }).tag, undefined, {
      timeout: 50,
    }),
    TimeoutError,
  );
  const timeoutElapsed = performance.now() - timeoutStarted;
  assert.ok(
    timeoutElapsed < 350,
    `expected timeout near 50ms without 1000ms releaseObjectGroup stall, got ${timeoutElapsed}ms`,
  );
  // Wait briefly for the queued releaseObjectGroup frame to reach ScriptedChrome.
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    releasedGroups.length > groupsBeforeTimeout,
    'chunk releaseObjectGroup must be registered on the wire even on timeout',
  );
  stallCallFnAndRelease = false;
  await session.detach();

  // Real V8 verification via node:inspector: throwOnSideEffect + zero lexical shadowing (including
  // __nd_a and __nd_fn) + Promise return rejection.
  const v8 = new inspector.Session();
  v8.connect();
  const v8Send = <T = unknown>(method: string, params?: Record<string, unknown>) =>
    new Promise<T>((res, rej) =>
      v8.post(method, params, (err, result) => (err ? rej(err) : res(result as T))),
    );
  try {
    const savedGlobals = {
      arg: (globalThis as Record<string, unknown>).arg,
      els: (globalThis as Record<string, unknown>).els,
      out: (globalThis as Record<string, unknown>).out,
      __nd_a: (globalThis as Record<string, unknown>).__nd_a,
      __nd_fn: (globalThis as Record<string, unknown>).__nd_fn,
      __nodriver_isolated_world_guard__: (globalThis as Record<string, unknown>)
        .__nodriver_isolated_world_guard__,
    };
    (globalThis as Record<string, unknown>).arg = 'BARE_GLOBAL_ARG';
    (globalThis as Record<string, unknown>).els = 'BARE_GLOBAL_ELS';
    (globalThis as Record<string, unknown>).out = 'BARE_GLOBAL_OUT';
    (globalThis as Record<string, unknown>).__nd_a = 23;
    (globalThis as Record<string, unknown>).__nd_fn = 99;
    (globalThis as Record<string, unknown>).__nodriver_isolated_world_guard__ = 'ndg:v8check';
    try {
      const g = await v8Send<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
        expression: 'globalThis',
        objectGroup: 'v8-g0',
      });
      const elA = await v8Send<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
        expression: '({ isConnected: true, id: "ok-1" })',
        objectGroup: 'v8-g1',
      });
      const elB = await v8Send<Protocol.Runtime.EvaluateResponse>('Runtime.evaluate', {
        expression: '({ isConnected: false, id: "detached-2" })',
        objectGroup: 'v8-g1',
      });
      // Capture the exact functionDeclaration generated by IsolatedWorld.callOnNodes for a function
      // that reads bare global identifiers `__nd_a`, `__nd_fn`, `arg`, `els`, `out`.
      const v8Session = await browser.attachSession(targetId);
      const v8GuardWorld = createIsolatedWorld(v8Session, {
        worldName: 'v8-guard-world',
        verification: 'guard',
      });
      const bareGlobalFn = new Function(
        'el',
        'passed',
        'return el.id + "|" + passed + "|" + __nd_a + "|" + __nd_fn + "|" + arg + "|" + els + "|" + out',
      ) as (el: Element, passed: string) => string;
      const beforeBare = callFnParamsLog.length;
      await v8GuardWorld
        .callOnNodes([1], bareGlobalFn, 'P1', { throwOnSideEffect: true })
        .catch(() => {});
      const bareDecl = callFnParamsLog
        .slice(beforeBare)
        .find((p) => p.functionDeclaration.includes('__nd_fn'))?.functionDeclaration;
      assert.ok(bareDecl);
      const v8Decl = bareDecl.replace(/ndg:[^"]+/, 'ndg:v8check');
      const pureRes = await v8Send<Protocol.Runtime.CallFunctionOnResponse>(
        'Runtime.callFunctionOn',
        {
          objectId: g.result.objectId!,
          objectGroup: 'v8-g1',
          functionDeclaration: v8Decl,
          arguments: [
            { value: 'P1' },
            { objectId: elA.result.objectId! },
            { objectId: elB.result.objectId! },
          ],
          returnByValue: true,
          throwOnSideEffect: true,
        },
      );
      assert.equal(pureRes.exceptionDetails, undefined);
      assert.deepEqual(pureRes.result.value, [
        {
          ok: true,
          value: 'ok-1|P1|23|99|BARE_GLOBAL_ARG|BARE_GLOBAL_ELS|BARE_GLOBAL_OUT',
        },
        { ok: false, stale: true },
      ]);

      // Promise-returning callback is rejected in real V8 instead of returning `{ ok: true, value: {} }`.
      const beforeAsync = callFnParamsLog.length;
      const promiseFn = new Function('el', 'return Promise.resolve(el.id)') as (
        el: Element,
      ) => string;
      await v8GuardWorld.callOnNodes([1], promiseFn, 'P1').catch(() => {});
      const asyncDecl = callFnParamsLog
        .slice(beforeAsync)
        .find((p) => p.functionDeclaration.includes('Promise.resolve'))?.functionDeclaration;
      assert.ok(asyncDecl);
      const asyncRes = await v8Send<Protocol.Runtime.CallFunctionOnResponse>(
        'Runtime.callFunctionOn',
        {
          objectId: g.result.objectId!,
          objectGroup: 'v8-g1',
          functionDeclaration: asyncDecl.replace(/ndg:[^"]+/, 'ndg:v8check'),
          arguments: [{ value: 'P1' }, { objectId: elA.result.objectId! }],
          returnByValue: true,
        },
      );
      assert.ok(asyncRes.exceptionDetails);
      assert.match(
        String(
          asyncRes.exceptionDetails.exception?.value ??
            asyncRes.exceptionDetails.exception?.description ??
            '',
        ),
        /__nodriver_iso_async_/,
      );

      // Regression (P2): rejected Promise returned by a sync callback rejects with asyncSentinel
      // AND leaves ZERO unhandledRejection events in real V8!
      let unhandledCount = 0;
      const onUnhandled = () => {
        unhandledCount++;
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const beforeRejected = callFnParamsLog.length;
        const rejectedFn = new Function(
          'el',
          'return Promise.reject(new Error("sync-rejected:" + el.id))',
        ) as (el: Element) => string;
        await v8GuardWorld.callOnNodes([1], rejectedFn, 'P1').catch(() => {});
        const rejectedDecl = callFnParamsLog
          .slice(beforeRejected)
          .find((p) => p.functionDeclaration.includes('sync-rejected:'))?.functionDeclaration;
        assert.ok(rejectedDecl);
        const rejectedRes = await v8Send<Protocol.Runtime.CallFunctionOnResponse>(
          'Runtime.callFunctionOn',
          {
            objectId: g.result.objectId!,
            objectGroup: 'v8-g1',
            functionDeclaration: rejectedDecl.replace(/ndg:[^"]+/, 'ndg:v8check'),
            arguments: [{ value: 'P1' }, { objectId: elA.result.objectId! }],
            returnByValue: true,
          },
        );
        assert.ok(rejectedRes.exceptionDetails);
        assert.match(
          String(
            rejectedRes.exceptionDetails.exception?.value ??
              rejectedRes.exceptionDetails.exception?.description ??
              '',
          ),
          /__nodriver_iso_async_/,
        );
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(
          unhandledCount,
          0,
          'rejected Promise returned by callOnNodes callback must not leak unhandledRejection',
        );
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }

      // Side-effectful fn generated through callOnNodes is rejected by real V8 under throwOnSideEffect: true.
      const beforeImpure = callFnParamsLog.length;
      await v8GuardWorld
        .callOnNodes(
          [1],
          (el) => {
            (globalThis as Record<string, unknown>).__v8SideEffect = 1;
            return (el as unknown as { id: string }).id;
          },
          'P1',
          { throwOnSideEffect: true },
        )
        .catch(() => {});
      await v8Session.detach();
      const impureDecl = callFnParamsLog
        .slice(beforeImpure)
        .find((p) => p.functionDeclaration.includes('__v8SideEffect'))?.functionDeclaration;
      assert.ok(impureDecl);
      const sideEffectDecl = impureDecl.replace(/ndg:[^"]+/, 'ndg:v8check');
      const impureRes = await v8Send<Protocol.Runtime.CallFunctionOnResponse>(
        'Runtime.callFunctionOn',
        {
          objectId: g.result.objectId!,
          objectGroup: 'v8-g1',
          functionDeclaration: sideEffectDecl,
          arguments: [{ value: 'P1' }, { objectId: elA.result.objectId! }],
          returnByValue: true,
          throwOnSideEffect: true,
        },
      );
      assert.ok(impureRes.exceptionDetails);
      assert.match(impureRes.exceptionDetails.exception?.description ?? '', /Possible side-effect/);
      assert.equal((globalThis as Record<string, unknown>).__v8SideEffect, undefined);
    } finally {
      for (const [k, v] of Object.entries(savedGlobals)) {
        if (v === undefined) delete (globalThis as Record<string, unknown>)[k];
        else (globalThis as Record<string, unknown>)[k] = v;
      }
    }
  } finally {
    v8.disconnect();
  }
});

test('3. parseDOMSnapshot decodes strings, multi-documents, rare fields, sparse layouts, computedStyles, and cssScale lazily', () => {
  const strings = [
    '', // 0
    'https://app.test/', // 1
    'Main Title', // 2
    'frame-main', // 3
    '#document', // 4
    'BODY', // 5
    'BUTTON', // 6
    'INPUT', // 7
    'IFRAME', // 8
    'SPAN', // 9
    'id', // 10
    'submit-btn', // 11
    'data-Role', // 12
    'primary', // 13
    '__proto__', // 14
    'safe-val', // 15
    'open', // 16
    'before', // 17
    'hello-input', // 18
    'https://cdn.test/a.png', // 19
    'block', // 20
    'visible', // 21
    'pointer', // 22
    'Submit', // 23
    'rgb(255, 255, 255)', // 24
    'https://child.test/', // 25
    'frame-child', // 26
    'P', // 27
    'child text', // 28
    '#text', // 29
    'en-US', // 30
    'UTF-8', // 31
    'textarea-val', // 32
  ];
  const raw: Protocol.DOMSnapshot.CaptureSnapshotResponse = {
    strings,
    documents: [
      {
        documentURL: 1,
        title: 2,
        baseURL: 1,
        contentLanguage: 30,
        encodingName: 31,
        publicId: -1,
        systemId: -1,
        frameId: 3,
        scrollOffsetX: 12,
        scrollOffsetY: 34,
        contentWidth: 1200,
        contentHeight: 900,
        nodes: {
          parentIndex: [-1, 0, 1, 1, 1, 1],
          nodeType: [9, 1, 1, 1, 1, 1],
          nodeName: [4, 5, 6, 7, 8, 9],
          nodeValue: [-1, -1, -1, -1, -1, -1],
          backendNodeId: [10, 11, 12, 13, 14, 15],
          attributes: [[], [], [10, 11, 12, 13, 14, 15], [], [], []],
          shadowRootType: { index: [1], value: [16] },
          pseudoType: { index: [5], value: [17] },
          textValue: { index: [5], value: [32] },
          inputValue: { index: [3], value: [18] },
          inputChecked: { index: [3] },
          optionSelected: { index: [3] },
          isClickable: { index: [2] },
          currentSourceURL: { index: [2], value: [19] },
          originURL: { index: [2], value: [1] },
          contentDocumentIndex: { index: [4], value: [1] },
        },
        layout: {
          // Node 2 laid out at layoutIdx 0; node 5 (inline span) split across layoutIdx 1 & 2; node 3 unlaid out.
          nodeIndex: [2, 5, 5],
          styles: [
            [20, 21, 22, 0],
            [20, 21, -1, 0],
            [20, 21, -1, 0],
          ],
          bounds: [
            [20, 40, 200, 80],
            [10, 100, 100, 20],
            [10, 120, 60, 20],
          ],
          text: [23, -1, -1],
          stackingContexts: { index: [0] },
          paintOrders: [5, 6, 7],
          offsetRects: [
            [2, 4, 200, 80],
            [0, 0, 100, 20],
            [0, 20, 60, 20],
          ],
          scrollRects: [[0, 0, 200, 80]],
          clientRects: [[0, 0, 196, 76]],
          blendedBackgroundColors: [24],
          textColorOpacities: [0.9],
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
      {
        documentURL: 25,
        title: -1,
        baseURL: 25,
        contentLanguage: -1,
        encodingName: 31,
        publicId: -1,
        systemId: -1,
        frameId: 26,
        nodes: {
          parentIndex: [-1, 0, 1],
          nodeType: [9, 1, 3],
          nodeName: [4, 27, 29],
          nodeValue: [-1, -1, 28],
          backendNodeId: [20, 21, 22],
          attributes: [[], [], []],
        },
        layout: {
          nodeIndex: [],
          styles: [],
          bounds: [],
          text: [],
          stackingContexts: { index: [] },
        },
        textBoxes: { layoutIndex: [], bounds: [], start: [], length: [] },
      },
    ],
  };

  assert.throws(() => parseDOMSnapshot(raw, { cssScale: 0 }), RangeError);
  assert.throws(() => parseDOMSnapshot(raw, { cssScale: -2 }), RangeError);
  assert.throws(() => parseDOMSnapshot(raw, { cssScale: Number.NaN }), RangeError);

  const snap = parseDOMSnapshot(raw, {
    computedStyles: ['display', 'visibility', 'cursor', 'opacity'],
    cssScale: 2,
  });
  assert.equal(snap.omitEmptyStyles, false);
  assert.equal(snap.documents.length, 2);
  assert.equal(snap.string(-1), '');
  assert.equal(snap.string(999), '');

  const main = snap.rootDocument!;
  assert.equal(main.documentURL, 'https://app.test/');
  assert.equal(main.title, 'Main Title');
  assert.equal(main.frameId, 'frame-main');
  assert.equal(main.contentLanguage, 'en-US');
  assert.equal(main.encodingName, 'UTF-8');
  assert.equal(main.scrollOffsetX, 12);
  assert.equal(main.scrollOffsetY, 34);
  assert.equal(main.contentWidth, 1200);
  assert.equal(main.contentHeight, 900);
  assert.equal(main.nodeCount, 6);
  assert.equal([...main.nodes()].length, 6);
  assert.equal(main.node(-1), undefined);
  assert.equal(main.node(99), undefined);

  const btn = main.nodeByBackendId(12)!;
  assert.equal(btn.tag, 'button');
  assert.equal(btn.parent?.tag, 'body');
  assert.equal(btn.parent?.shadowRootType, 'open');
  assert.deepEqual(btn.parent?.childIndexes, [2, 3, 4, 5]);
  assert.equal(btn.attribute('id'), 'submit-btn');
  assert.equal(btn.attribute('ID'), 'submit-btn');
  assert.equal(btn.attribute('data-Role'), 'primary');
  assert.equal(btn.attribute('__proto__'), 'safe-val');
  assert.equal(Object.getPrototypeOf(btn.attributes), null);
  assert.equal(btn.isClickable, true);
  assert.equal(btn.currentSourceURL, 'https://cdn.test/a.png');
  assert.equal(btn.originURL, 'https://app.test/');
  assert.equal(btn.hasLayout, true);
  assert.equal(btn.layoutIndex, 0);
  assert.deepEqual(btn.bounds, { x: 10, y: 20, width: 100, height: 40 });
  assert.deepEqual(btn.offsetRect, { x: 1, y: 2, width: 100, height: 40 });
  assert.deepEqual(btn.scrollRect, { x: 0, y: 0, width: 100, height: 40 });
  assert.deepEqual(btn.clientRect, { x: 0, y: 0, width: 98, height: 38 });
  assert.equal(btn.layoutText, 'Submit');
  assert.equal(btn.paintOrder, 5);
  assert.equal(btn.isStackingContext, true);
  assert.equal(btn.blendedBackgroundColor, 'rgb(255, 255, 255)');
  assert.equal(btn.textColorOpacity, 0.9);
  assert.equal(btn.style('display'), 'block');
  assert.equal(btn.style('cursor'), 'pointer');
  assert.equal(btn.style('opacity'), '');
  assert.equal(btn.style('color'), undefined);
  assert.deepEqual(
    { ...btn.styles },
    { display: 'block', visibility: 'visible', cursor: 'pointer', opacity: '' },
  );

  // Unlaid-out input node with rare fields.
  const input = main.node(3)!;
  assert.equal(input.tag, 'input');
  assert.equal(input.inputValue, 'hello-input');
  assert.equal(input.inputChecked, true);
  assert.equal(input.optionSelected, true);
  assert.equal(input.isClickable, false);
  assert.equal(input.hasLayout, false);
  assert.equal(input.bounds, undefined);
  assert.deepEqual(input.allBounds, []);
  assert.deepEqual({ ...input.styles }, {});
  assert.equal(input.style('display'), undefined);

  // Multi-layout inline span: default omitEmptyStyles: false preserves `-1` and `''` as `''`.
  const span = main.node(5)!;
  assert.equal(span.pseudoType, 'before');
  assert.equal(span.textValue, 'textarea-val');
  assert.deepEqual(span.layoutIndexes, [1, 2]);
  assert.deepEqual(span.allBounds, [
    { x: 5, y: 50, width: 50, height: 10 },
    { x: 5, y: 60, width: 30, height: 10 },
  ]);
  assert.equal(span.style('cursor'), '');
  assert.equal(span.style('opacity'), '');
  assert.deepEqual(
    { ...span.styles },
    { display: 'block', visibility: 'visible', cursor: '', opacity: '' },
  );

  // omitEmptyStyles: true omits both `-1` and empty string-table entries from styles/style().
  const cleanSnap = parseDOMSnapshot(raw, {
    computedStyles: ['display', 'visibility', 'cursor', 'opacity'],
    cssScale: 2,
    omitEmptyStyles: true,
  });
  assert.equal(cleanSnap.omitEmptyStyles, true);
  const cleanBtn = cleanSnap.rootDocument!.nodeByBackendId(12)!;
  assert.deepEqual(
    { ...cleanBtn.styles },
    { display: 'block', visibility: 'visible', cursor: 'pointer' },
  );
  assert.equal('opacity' in cleanBtn.styles, false);
  assert.equal(cleanBtn.style('opacity'), undefined);
  assert.equal(Number(cleanBtn.styles.opacity ?? '1'), 1);
  const cleanSpan = cleanSnap.rootDocument!.node(5)!;
  assert.deepEqual({ ...cleanSpan.styles }, { display: 'block', visibility: 'visible' });
  assert.equal(cleanSpan.style('cursor'), undefined);
  assert.equal(cleanSpan.style('opacity'), undefined);

  // Frame owner -> childDocument + cross-document backend lookup.
  const iframe = main.node(4)!;
  assert.equal(iframe.childDocumentIndex, 1);
  assert.equal(iframe.childDocument, snap.documentByFrameId('frame-child'));
  assert.equal(iframe.childDocument?.documentURL, 'https://child.test/');
  const childText = snap.findNodeByBackendId(22)!;
  assert.equal(childText.nodeType, 3);
  assert.equal(childText.tag, '');
  assert.equal(childText.nodeValue, 'child text');
  assert.equal(childText.parent?.tag, 'p');
  assert.equal(snap.findNodeByBackendId(999999), undefined);
});

test('4. IsolatedWorldPool and evaluateAcrossFrames fan out with concurrency, per-frame isolation, target cache reuse, and fatal abort/timeout', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://frames.test/' }] });
  let nextContext = 50;
  const ctxToFrame = new Map<number, string>();
  const worldCreates: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let stallFrame: string | undefined;

  chrome.handle('Page.createIsolatedWorld', (params) => {
    worldCreates.push(params.frameId);
    if (params.frameId === 'frame-detached')
      throw new ProtocolError('Page.createIsolatedWorld', -32000, 'No frame for given id found');
    const ctx = ++nextContext;
    ctxToFrame.set(ctx, params.frameId);
    return { executionContextId: ctx };
  });
  let navContextDestroyedOnce = true;
  chrome.handle('Runtime.evaluate', async (params) => {
    const frameId = ctxToFrame.get(params.contextId!) ?? 'unknown';
    if (frameId === stallFrame) return NO_REPLY;
    if (frameId === 'frame-nav' && navContextDestroyedOnce) {
      navContextDestroyedOnce = false;
      throw new ProtocolError('Runtime.evaluate', -32000, 'Execution context was destroyed');
    }
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 25));
    inFlight--;
    if (frameId === 'frame-throw') {
      return {
        result: { type: 'undefined' },
        exceptionDetails: {
          exceptionId: 1,
          text: 'Uncaught',
          lineNumber: 0,
          columnNumber: 0,
          exception: { type: 'object', description: 'ReferenceError: missingVar is not defined' },
        },
      };
    }
    return { result: { type: 'string', value: `ok:${frameId}` } };
  });

  await using browser = await chrome.connect({ attach: 'none', beforeSend: forbidEnable });
  const targetId = browser.pageTargets[0]!.targetId;
  const session1 = await browser.attachSession(targetId);

  // Validation errors fail fast before any CDP work.
  await assert.rejects(
    evaluateAcrossFrames(session1, ['f1', ''], '1', undefined, { verification: 'none' }),
    TypeError,
  );
  await assert.rejects(
    evaluateAcrossFrames(session1, ['f1'], '1', undefined, {
      verification: 'none',
      concurrency: 0,
    }),
    RangeError,
  );
  assert.deepEqual(
    await evaluateAcrossFrames(session1, [], '1', undefined, { verification: 'none' }),
    [],
  );

  // Concurrency cap (max 2) + per-frame detached & script error isolation.
  const outcomes = await evaluateAcrossFrames<string>(
    session1,
    ['f1', 'frame-detached', 'f2', 'frame-throw', 'f3', 'f4'],
    'location.href',
    undefined,
    { scope: 'target', verification: 'none', worldName: 'pool-shared', concurrency: 2 },
  );
  assert.ok(maxInFlight <= 2, `expected concurrency <= 2, got ${maxInFlight}`);
  assert.equal(outcomes.length, 6);
  assert.deepEqual(outcomes[0], { status: 'ok', frameId: 'f1', value: 'ok:f1' });
  assert.equal(outcomes[1]!.status, 'detached');
  assert.equal(outcomes[1]!.frameId, 'frame-detached');
  assert.ok(outcomes[1]!.status === 'detached' && outcomes[1]!.error instanceof StaleElementError);
  assert.deepEqual(outcomes[2], { status: 'ok', frameId: 'f2', value: 'ok:f2' });
  assert.equal(outcomes[3]!.status, 'error');
  assert.ok(outcomes[3]!.status === 'error' && outcomes[3]!.error instanceof EvaluationError);
  assert.deepEqual(outcomes[4], { status: 'ok', frameId: 'f3', value: 'ok:f3' });
  assert.deepEqual(outcomes[5], { status: 'ok', frameId: 'f4', value: 'ok:f4' });

  // Target-scoped cache reuse across a fresh detached/re-attached TargetSession: zero new createIsolatedWorld!
  await session1.detach();
  const session2 = await browser.attachSession(targetId);
  const createsBeforeReuse = worldCreates.length;
  const reused = await evaluateAcrossFrames<string>(
    session2,
    ['f1', 'f2', 'f3'],
    'location.href',
    undefined,
    { scope: 'target', verification: 'none', worldName: 'pool-shared' },
  );
  assert.equal(worldCreates.length, createsBeforeReuse);
  assert.deepEqual(
    reused.map((o) => (o.status === 'ok' ? o.value : o.status)),
    ['ok:f1', 'ok:f2', 'ok:f3'],
  );

  // IsolatedWorldPool instance: evaluate, invalidate, dispose, and fatal timeout aborting siblings.
  const pool = createIsolatedWorldPool(session2, {
    scope: 'target',
    verification: 'none',
    worldName: 'pool-shared',
  });
  assert.ok(pool instanceof IsolatedWorldPool);
  assert.equal(await pool.evaluate('f1', '1'), 'ok:f1');
  pool.invalidate('f1');
  assert.equal(await pool.evaluate('f1', '1'), 'ok:f1');
  assert.equal(worldCreates.at(-1), 'f1');

  // Regression (P2): Execution context was destroyed on a still-mounted frame with
  // retryOnContextGone: false must report status: 'error' (NOT 'detached'), and subsequent evals succeed.
  const navOutcomes = await pool.evaluateAll(['frame-nav', 'frame-detached'], '1', undefined, {
    retryOnContextGone: false,
  });
  assert.equal(navOutcomes[0]!.status, 'error');
  assert.ok(
    navOutcomes[0]!.status === 'error' &&
      navOutcomes[0]!.error instanceof ProtocolError &&
      /Execution context was destroyed/.test(navOutcomes[0]!.error.message),
  );
  assert.equal(navOutcomes[1]!.status, 'detached');
  assert.equal(await pool.evaluate('frame-nav', '1'), 'ok:frame-nav');

  stallFrame = 'f2';
  const started = performance.now();
  await assert.rejects(
    pool.evaluateAll(['f1', 'f2', 'f3'], '1', undefined, { timeout: 60 }),
    TimeoutError,
  );
  assert.ok(performance.now() - started < 400);

  // AbortSignal immediately rejects and stops sibling work.
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('stop fanout')), 30);
  await assert.rejects(
    pool.evaluateAll(['f2', 'f3'], '1', undefined, { signal: ac.signal }),
    /stop fanout/,
  );

  pool.dispose();
  assert.throws(() => pool.world('f1'), StaleElementError);
  await assert.rejects(pool.evaluateAll(['f1'], '1'), StaleElementError);
});

test('5. getNodeEventListeners works with zero *.enable, releases all handler handles (including late replies), and normalizes stale nodes', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://listeners.test/' }] });
  let nextContext = 200;
  const releasedObjects: string[] = [];
  const releasedGroups: string[] = [];
  const listenerQueries: Protocol.DOMDebugger.GetEventListenersRequest[] = [];
  let resolveGate: Promise<void> | undefined;
  let resolveArrived: (() => void) | undefined;
  let listenersGate: Promise<void> | undefined;
  let listenersArrived: (() => void) | undefined;

  const resolvedParams: Protocol.DOM.ResolveNodeRequest[] = [];
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: ++nextContext }));
  chrome.handle('DOM.resolveNode', async (params) => {
    const p = params!;
    resolvedParams.push(p);
    if (p.backendNodeId === 404)
      throw new ProtocolError('DOM.resolveNode', -32000, 'No node with given id found');
    if (resolveGate) {
      resolveArrived?.();
      await resolveGate;
    }
    return { object: { type: 'object', objectId: `node-obj-${p.backendNodeId}` } };
  });
  let stallListenersAndRelease = false;
  chrome.handle('DOMDebugger.getEventListeners', async (params) => {
    listenerQueries.push(params);
    if (stallListenersAndRelease) return NO_REPLY;
    if (listenersGate) {
      listenersArrived?.();
      await listenersGate;
    }
    return {
      listeners: [
        {
          type: 'click',
          useCapture: false,
          passive: true,
          once: false,
          scriptId: '42',
          lineNumber: 10,
          columnNumber: 2,
          backendNodeId: 77,
          handler: {
            type: 'function',
            objectId: 'h-click-1',
            description: 'function onClick() {}',
          },
          originalHandler: {
            type: 'function',
            objectId: 'h-click-orig-1',
            description: 'function origClick() {}',
          },
        },
        {
          type: 'keydown',
          useCapture: true,
          passive: false,
          once: true,
          scriptId: '43',
          lineNumber: 20,
          columnNumber: 4,
          handler: {
            type: 'function',
            objectId: 'h-click-1', // duplicate handle ID must be deduped on release
            description: 'function shared() {}',
          },
        },
      ],
    };
  });
  chrome.handle('Runtime.releaseObject', (params) => {
    releasedObjects.push(params.objectId);
  });
  chrome.handle('Runtime.releaseObjectGroup', (params) => {
    releasedGroups.push(params.objectGroup);
    if (stallListenersAndRelease) return NO_REPLY;
  });

  await using browser = await chrome.connect({ attach: 'none', beforeSend: forbidEnable });
  const targetId = browser.pageTargets[0]!.targetId;
  const session = await browser.attachSession(targetId);
  const otherSession = await browser.attachSession(targetId);
  const world = createIsolatedWorld(session, { worldName: 'ev-world', verification: 'none' });
  const otherWorld = createIsolatedWorld(otherSession, {
    worldName: 'ev-world',
    verification: 'none',
  });

  // Validation errors.
  await assert.rejects(
    getNodeEventListeners(session, { objectId: 'o1' }, { depth: -2 }),
    RangeError,
  );
  await assert.rejects(getNodeEventListeners(session, { objectId: '' }), TypeError);
  await assert.rejects(getNodeEventListeners(session, { backendNodeId: 0 }), RangeError);
  await assert.rejects(
    getNodeEventListeners(session, { objectId: 'o1', backendNodeId: 1 } as never),
    TypeError,
  );
  await assert.rejects(
    getNodeEventListeners(session, { backendNodeId: 1 }, { world: otherWorld }),
    TypeError,
  );
  await assert.rejects(
    getNodeEventListeners(session, { backendNodeId: 1 }, { world, executionContextId: 12 }),
    TypeError,
  );

  // 1) Direct objectId query: forwards depth/pierce, maps metadata, dedupes & releases handler handles.
  const direct = await getNodeEventListeners(
    session,
    { objectId: 'existing-el-1' },
    { depth: -1, pierce: true },
  );
  await browser.drain();
  assert.deepEqual(listenerQueries.at(-1), {
    objectId: 'existing-el-1',
    depth: -1,
    pierce: true,
  });
  assert.deepEqual(direct, [
    {
      type: 'click',
      useCapture: false,
      passive: true,
      once: false,
      scriptId: '42',
      lineNumber: 10,
      columnNumber: 2,
      backendNodeId: 77,
      handlerDescription: 'function onClick() {}',
      originalHandlerDescription: 'function origClick() {}',
    },
    {
      type: 'keydown',
      useCapture: true,
      passive: false,
      once: true,
      scriptId: '43',
      lineNumber: 20,
      columnNumber: 4,
      handlerDescription: 'function shared() {}',
    },
  ]);
  assert.deepEqual(releasedObjects.slice(-2).sort(), ['h-click-1', 'h-click-orig-1']);

  // 2) Default { backendNodeId } omits executionContextId on DOM.resolveNode (read-only main-world
  // handle -> inspects page main-world listeners with zero *.enable).
  const groupsBefore = releasedGroups.length;
  const viaMainDefault = await getNodeEventListeners(session, { backendNodeId: 66 });
  await browser.drain();
  assert.equal(viaMainDefault.length, 2);
  assert.equal(releasedGroups.length, groupsBefore + 1);
  assert.equal(resolvedParams.at(-1)!.backendNodeId, 66);
  assert.equal('executionContextId' in resolvedParams.at(-1)!, false);

  // 3) backendNodeId + IsolatedWorld: passes isolated executionContextId to inspect that world's listeners.
  const viaWorld = await getNodeEventListeners(session, { backendNodeId: 77 }, { world });
  await browser.drain();
  assert.equal(viaWorld.length, 2);
  assert.equal(releasedGroups.length, groupsBefore + 2);
  assert.equal(typeof resolvedParams.at(-1)!.executionContextId, 'number');
  assert.equal(listenerQueries.at(-1)!.objectId, 'node-obj-77');

  // 4) backendNodeId + raw executionContextId.
  const viaCtx = await getNodeEventListeners(
    session,
    { backendNodeId: 88 },
    { executionContextId: 999 },
  );
  await browser.drain();
  assert.equal(viaCtx.length, 2);
  assert.equal(releasedGroups.length, groupsBefore + 3);
  assert.equal(resolvedParams.at(-1)!.executionContextId, 999);

  // 4) Stale node -> StaleElementError (cause: ProtocolError).
  await assert.rejects(
    getNodeEventListeners(session, { backendNodeId: 404 }, { world }),
    (error: unknown) => {
      assert.ok(error instanceof StaleElementError);
      assert.ok(error.cause instanceof ProtocolError);
      return true;
    },
  );

  // 5) Late reply after abort for DOMDebugger.getEventListeners releases returned handler handles before drain().
  let releaseListeners!: () => void;
  listenersGate = new Promise<void>((r) => {
    releaseListeners = r;
  });
  const waitListeners = new Promise<void>((r) => {
    listenersArrived = r;
  });
  const ac1 = new AbortController();
  const pending1 = getNodeEventListeners(
    session,
    { objectId: 'existing-el-2' },
    { signal: ac1.signal },
  ).catch((e: unknown) => e);
  await waitListeners;
  ac1.abort(new Error('abort listeners'));
  assert.match(String(await pending1), /abort listeners/);
  const relBeforeLate1 = releasedObjects.length;
  releaseListeners();
  listenersGate = undefined;
  await browser.drain();
  assert.deepEqual(releasedObjects.slice(relBeforeLate1).sort(), ['h-click-1', 'h-click-orig-1']);

  // 6) Late reply after abort for DOM.resolveNode releases via the internal objectGroup (zero Runtime.releaseObject) before drain().
  let releaseResolve!: () => void;
  resolveGate = new Promise<void>((r) => {
    releaseResolve = r;
  });
  const waitResolve = new Promise<void>((r) => {
    resolveArrived = r;
  });
  const ac2 = new AbortController();
  const pending2 = getNodeEventListeners(
    session,
    { backendNodeId: 55 },
    { signal: ac2.signal },
  ).catch((e: unknown) => e);
  await waitResolve;
  ac2.abort(new Error('abort resolve'));
  assert.match(String(await pending2), /abort resolve/);
  const relBeforeLate2 = releasedObjects.length;
  const groupsBeforeLate2 = releasedGroups.length;
  releaseResolve();
  resolveGate = undefined;
  await browser.drain();
  assert.deepEqual(releasedObjects.slice(relBeforeLate2), []);
  assert.ok(releasedGroups.length > groupsBeforeLate2);

  // 7) Regression (P2): default backendNodeId path with timeout: 50 and stalled
  // DOMDebugger.getEventListeners + Runtime.releaseObjectGroup rejects near 50ms (NOT ~1050ms),
  // while registering Runtime.releaseObjectGroup on the connection for drain().
  stallListenersAndRelease = true;
  const groupsBeforeTimeout = releasedGroups.length;
  const started = performance.now();
  await assert.rejects(
    getNodeEventListeners(session, { backendNodeId: 66 }, { timeout: 50 }),
    TimeoutError,
  );
  const elapsed = performance.now() - started;
  assert.ok(
    elapsed < 350,
    `expected timeout near 50ms without 1000ms releaseObjectGroup stall, got ${elapsed}ms`,
  );
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(
    releasedGroups.length > groupsBeforeTimeout,
    'Runtime.releaseObjectGroup must be registered on the wire on timeout',
  );
  stallListenersAndRelease = false;

  await otherSession.detach();
});

test('6. setWindowState and Tab.windowBounds keep default 1-readback and optionally poll until windowState settles', async () => {
  await using chrome = await ScriptedChrome.start({ pages: [{ url: 'https://win.test/' }] });
  let currentBounds: Protocol.Browser.Bounds = {
    left: 0,
    top: 0,
    width: 1200,
    height: 800,
    windowState: 'normal',
  };
  let transientReadsRemaining = 0;
  let pendingTargetState: Protocol.Browser.WindowState | undefined;
  let getBoundsCount = 0;
  let setBoundsDelayMs = 0;

  chrome.handle('Browser.getWindowForTarget', () => ({ windowId: 7, bounds: currentBounds }));
  chrome.handle('Browser.setWindowBounds', async (params) => {
    if (setBoundsDelayMs > 0) await new Promise((r) => setTimeout(r, setBoundsDelayMs));
    pendingTargetState = params.bounds.windowState;
    currentBounds = {
      ...currentBounds,
      ...params.bounds,
      windowState:
        transientReadsRemaining > 0
          ? currentBounds.windowState
          : (params.bounds.windowState ?? currentBounds.windowState),
    };
  });
  chrome.handle('Browser.getWindowBounds', () => {
    getBoundsCount++;
    if (transientReadsRemaining > 0) {
      transientReadsRemaining--;
      if (transientReadsRemaining === 0 && pendingTargetState) {
        // Settle on the next read after this transient one.
        const stale = { ...currentBounds };
        currentBounds = { ...currentBounds, windowState: pendingTargetState };
        return { bounds: stale };
      }
    }
    return { bounds: currentBounds };
  });

  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;

  // Validation: invalid pollIntervalMs throws RangeError even when waitForState is false.
  await assert.rejects(
    setWindowState(browser.cdp, tab.id, { windowState: 'normal' }, { pollIntervalMs: -1 }),
    RangeError,
  );
  await assert.rejects(
    setWindowState(browser.cdp, tab.id, { windowState: 'normal' }, { pollIntervalMs: Number.NaN }),
    RangeError,
  );

  // Default (waitForState omitted): single Browser.getWindowBounds read-back, no polling.
  transientReadsRemaining = 2;
  getBoundsCount = 0;
  const immediate = await tab.windowBounds({ windowState: 'minimized' });
  assert.equal(getBoundsCount, 1);
  assert.equal(immediate.windowState, 'normal');

  // waitForState: true with no windowState field: single read-back, no polling.
  transientReadsRemaining = 0;
  getBoundsCount = 0;
  const resized = await tab.windowBounds(
    { width: 900, height: 600 },
    { waitForState: true, pollIntervalMs: 10 },
  );
  assert.equal(getBoundsCount, 1);
  assert.equal(resized.width, 900);

  // waitForState: true with windowState polls past 2 transient 'normal' reads until 'minimized'.
  currentBounds = { ...currentBounds, windowState: 'normal' };
  transientReadsRemaining = 2;
  getBoundsCount = 0;
  const settled = await tab.windowBounds(
    { windowState: 'minimized' },
    { waitForState: true, pollIntervalMs: 10, timeout: 1000 },
  );
  assert.equal(settled.windowState, 'minimized');
  assert.equal(getBoundsCount, 3);

  // Standalone setWindowState on raw browser.cdp session works identically.
  transientReadsRemaining = 1;
  getBoundsCount = 0;
  const restored = await setWindowState(
    browser.cdp,
    tab.id,
    { windowState: 'normal' },
    { waitForState: true, pollIntervalMs: 10, timeout: 1000 },
  );
  assert.equal(restored.windowState, 'normal');
  assert.equal(getBoundsCount, 2);

  // Timeout when OS never settles (and honors time already spent in setWindowBounds).
  transientReadsRemaining = 100;
  setBoundsDelayMs = 40;
  const started = performance.now();
  await assert.rejects(
    setWindowState(
      browser.cdp,
      tab.id,
      { windowState: 'maximized' },
      { waitForState: true, pollIntervalMs: 15, timeout: 90 },
    ),
    TimeoutError,
  );
  assert.ok(performance.now() - started < 250);
  setBoundsDelayMs = 0;

  // AbortSignal cancels polling cleanly.
  transientReadsRemaining = 100;
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error('cancel window wait')), 30);
  await assert.rejects(
    setWindowState(
      browser.cdp,
      tab.id,
      { windowState: 'fullscreen' },
      { waitForState: true, pollIntervalMs: 15, signal: ac.signal },
    ),
    /cancel window wait/,
  );

  // Closed connection surfaces DisconnectedError cleanly.
  chrome.disconnect();
  await assert.rejects(
    setWindowState(browser.cdp, tab.id, { windowState: 'normal' }),
    DisconnectedError,
  );
});
