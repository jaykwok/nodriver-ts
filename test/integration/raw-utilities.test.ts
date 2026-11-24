import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Browser,
  createIsolatedWorld,
  createObjectGroup,
  evaluateAcrossFrames,
  getNodeEventListeners,
  isFrameGone,
  parseDOMSnapshot,
  setWindowState,
} from '../../src/index.ts';
import { poll } from '../../src/utils.ts';

test('raw-session utilities work end-to-end on real Chrome with zero *.enable commands', async () => {
  const sends: string[] = [];
  await using browser = await Browser.launch({
    headless: true,
    attach: 'none',
    beforeSend(method) {
      if (/^(DOM|Runtime|Page|Debugger)\.enable$/.test(method))
        throw new Error(`Forbidden enable command: ${method}`);
      sends.push(method);
    },
  });

  const html = `<!doctype html>
<html>
  <head><title>raw-utils</title></head>
  <body>
    <button id="action" style="width:120px;height:40px;cursor:pointer">Click Me</button>
    <div id="shadow-host"></div>
    <iframe id="child" srcdoc="<button id='inner'>Inside</button><script>document.getElementById('inner').addEventListener('click', function onIframeClick() {});</script>"></iframe>
    <script>
      document.getElementById('action').addEventListener('click', function onActionClick() {}, { passive: true });
      const sr = document.getElementById('shadow-host').attachShadow({ mode: 'open' });
      const sb = document.createElement('button');
      sb.id = 'shadow-btn';
      sb.textContent = 'Shadow';
      sb.addEventListener('mousedown', function onShadowDown() {});
      sr.appendChild(sb);
      window.__ready = true;
    </script>
  </body>
</html>`;
  const url = 'data:text/html,' + encodeURIComponent(html);
  const { targetId } = await browser.cdp.send('Target.createTarget', { url });
  const session = await browser.attachSession(targetId);

  const world = createIsolatedWorld(session, {
    worldName: 'raw-utils-world',
    scope: 'target',
    verification: 'guard',
  });

  // Wait for document + iframe to finish loading via the isolated world.
  await poll(
    async () => {
      const ready = await world.evaluate<boolean>(
        () =>
          document.readyState === 'complete' &&
          Boolean(document.getElementById('action')) &&
          Boolean(
            (
              document.getElementById('child') as HTMLIFrameElement | null
            )?.contentDocument?.getElementById('inner'),
          ),
      );
      return ready || undefined;
    },
    { timeout: 5000 },
    'raw-utils document ready',
  );

  // 1) DOMSnapshot.captureSnapshot + parseDOMSnapshot (zero DOM.enable).
  const rawSnapshot = await session.send('DOMSnapshot.captureSnapshot', {
    computedStyles: ['display', 'visibility', 'cursor'],
    includeDOMRects: true,
  });
  const snap = parseDOMSnapshot(rawSnapshot, {
    computedStyles: ['display', 'visibility', 'cursor'],
  });
  assert.ok(snap.documents.length >= 2);
  let buttonBackendId: number | undefined;
  for (const node of snap.rootDocument!.nodes()) {
    if (node.tag === 'button' && node.attribute('id') === 'action') {
      buttonBackendId = node.backendNodeId;
      assert.ok(node.bounds && node.bounds.width >= 100 && node.bounds.height >= 30);
      assert.equal(node.style('cursor'), 'pointer');
      break;
    }
  }
  assert.ok(buttonBackendId && buttonBackendId > 0, 'button backendNodeId found in snapshot');

  // 2) getNodeEventListeners with default { backendNodeId } (DOM.resolveNode without
  // executionContextId -> read-only main-world handle) returns main-world listeners cleanly in O(1)
  // via Runtime.releaseObjectGroup (zero Runtime.releaseObject commands), and types filter works.
  const releaseObjBefore = sends.filter((m) => m === 'Runtime.releaseObject').length;
  const releaseGroupBefore = sends.filter((m) => m === 'Runtime.releaseObjectGroup').length;
  const mainListeners = await getNodeEventListeners(session, { backendNodeId: buttonBackendId });
  await session.drain();
  const clickListener = mainListeners.find((l) => l.type === 'click');
  assert.ok(clickListener, 'expected main-world click listener from default main-world handle');
  assert.equal(clickListener.passive, true);
  assert.match(clickListener.handlerDescription ?? '', /onActionClick/);
  assert.equal(
    sends.filter((m) => m === 'Runtime.releaseObject').length,
    releaseObjBefore,
    'backendNodeId path must release listeners in O(1) via objectGroup with zero releaseObject commands',
  );
  assert.equal(
    sends.filter((m) => m === 'Runtime.releaseObjectGroup').length,
    releaseGroupBefore + 1,
  );

  // Confirm on real Blink that single Runtime.releaseObjectGroup invalidates all returned handler
  // objectIds across main document, shadow DOM and same-process iframe with depth:-1, pierce:true.
  const docBackendId = snap.rootDocument!.node(0)!.backendNodeId!;
  const allDocListeners = await getNodeEventListeners(
    session,
    { backendNodeId: docBackendId },
    { depth: -1, pierce: true, types: ['click', 'mousedown'] },
  );
  await session.drain();
  assert.ok(allDocListeners.some((l) => (l.handlerDescription ?? '').includes('onActionClick')));
  assert.ok(allDocListeners.some((l) => (l.handlerDescription ?? '').includes('onShadowDown')));
  assert.ok(allDocListeners.some((l) => (l.handlerDescription ?? '').includes('onIframeClick')));
  assert.equal(sends.filter((m) => m === 'Runtime.releaseObject').length, releaseObjBefore);

  // Direct proof that Blink places DOMDebugger.getEventListeners handler handles in the input objectGroup:
  const proofGroup = createObjectGroup(session);
  const { object: docObj } = await session.send('DOM.resolveNode', {
    backendNodeId: docBackendId,
    objectGroup: proofGroup.name,
  });
  const rawList = await session.send('DOMDebugger.getEventListeners', {
    objectId: docObj.objectId!,
    depth: -1,
    pierce: true,
  });
  const handlerIds = rawList.listeners
    .flatMap((l) => [l.handler?.objectId, l.originalHandler?.objectId])
    .filter((id): id is string => Boolean(id));
  assert.ok(handlerIds.length >= 3, 'expected handler handles across document, shadow and iframe');
  await proofGroup.release();
  for (const handlerId of handlerIds) {
    await assert.rejects(
      session.send('Runtime.getProperties', { objectId: handlerId }),
      /Could not find object with given id/i,
    );
  }

  const isoBefore = await getNodeEventListeners(
    session,
    { backendNodeId: buttonBackendId },
    { world },
  );
  assert.equal(
    isoBefore.some((l) => (l.handlerDescription ?? '').includes('onActionClick')),
    false,
    'isolated-world handle must not return main-world listeners',
  );
  await world.evaluate(() => {
    document.getElementById('action')!.addEventListener('pointerenter', function onIsoEnter() {});
  });
  const isoAfter = await getNodeEventListeners(
    session,
    { backendNodeId: buttonBackendId },
    { world },
  );
  assert.ok(
    isoAfter.some(
      (l) => l.type === 'pointerenter' && (l.handlerDescription ?? '').includes('onIsoEnter'),
    ),
    'isolated-world handle returns listeners registered inside that isolated world',
  );

  // 3) IsolatedWorld.callOnNodes with throwOnSideEffect: true on real V8.
  const batch = await world.callOnNodes(
    [buttonBackendId],
    (el, tagPrefix) => `${tagPrefix}:${el.tagName}:${el.id}`,
    'btn',
    { throwOnSideEffect: true },
  );
  assert.deepEqual(batch, [
    { ok: true, backendNodeId: buttonBackendId, value: 'btn:BUTTON:action' },
  ]);

  // 4) evaluateAcrossFrames across main + child + nonexistent frame.
  const frameIds = snap.documents.map((d) => d.frameId).filter(Boolean);
  assert.ok(frameIds.length >= 2);
  const outcomes = await evaluateAcrossFrames<string>(
    session,
    [...frameIds, 'nonexistent-frame-id'],
    () => document.body?.textContent?.trim() ?? '',
    undefined,
    { scope: 'target', verification: 'guard', worldName: 'raw-utils-world', concurrency: 2 },
  );
  assert.equal(outcomes[0]!.status, 'ok');
  assert.equal(outcomes[1]!.status, 'ok');
  const lastOutcome = outcomes.at(-1)!;
  assert.equal(lastOutcome.status, 'detached');
  assert.ok(isFrameGone(lastOutcome.error));

  // 5) setWindowState with waitForState: true.
  const bounds = await setWindowState(
    browser.cdp,
    targetId,
    { windowState: 'normal', width: 920, height: 640 },
    { waitForState: true, timeout: 3000 },
  );
  assert.equal(bounds.windowState, 'normal');

  await session.detach();
  await browser.drain();
  assert.equal(
    sends.some((m) => /^(DOM|Runtime|Page|Debugger)\.enable$/.test(m)),
    false,
  );
});
