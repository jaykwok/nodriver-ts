import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  Browser,
  createIsolatedWorld,
  evaluateAcrossFrames,
  getNodeEventListeners,
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
    <iframe id="child" srcdoc="<p id='inner'>Inside</p>"></iframe>
    <script>
      document.getElementById('action').addEventListener('click', function onActionClick() {}, { passive: true });
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
  // executionContextId -> read-only main-world handle) returns main-world listeners cleanly,
  // while passing { world } scopes results to listeners registered in that isolated world.
  const mainListeners = await getNodeEventListeners(session, { backendNodeId: buttonBackendId });
  const clickListener = mainListeners.find((l) => l.type === 'click');
  assert.ok(clickListener, 'expected main-world click listener from default main-world handle');
  assert.equal(clickListener.passive, true);
  assert.match(clickListener.handlerDescription ?? '', /onActionClick/);

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
  assert.equal(outcomes.at(-1)!.status, 'detached');

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
