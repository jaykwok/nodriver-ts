import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Protocol } from 'devtools-protocol';
import { ScriptedChrome } from '../../src/testing/index.ts';
import { Element, InputActionError, StaleElementError } from '../../src/index.ts';
import { Frame } from '../../src/page/frames.ts';
import type { Session } from '../../src/protocol/connection.ts';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

async function change(
  chrome: ScriptedChrome,
  session: Session,
  frameId: string,
  kind: 'navigate' | 'detach',
  parentId?: string,
) {
  if (kind === 'detach') {
    const received = session.waitFor('Page.frameDetached');
    chrome.emit('Page.frameDetached', { frameId, reason: 'remove' }, session.id);
    await received;
  } else {
    const frame: Protocol.Page.Frame = {
      id: frameId,
      parentId,
      loaderId: 'new-loader',
      url: 'about:blank',
      domainAndRegistry: '',
      securityOrigin: '://',
      mimeType: 'text/html',
      secureContextType: 'InsecureScheme',
      crossOriginIsolatedContextType: 'NotIsolated',
      gatedAPIFeatures: [],
    };
    const received = session.waitFor('Page.frameNavigated');
    chrome.emit('Page.frameNavigated', { frame, type: 'Navigation' }, session.id);
    await received;
  }
}

for (const kind of ['navigate', 'detach'] as const) {
  for (const input of ['tab', 'element', 'composition'] as const) {
    test(`${input} input ignores unrelated frame ${kind} while awaiting an ACK`, async () => {
      await using chrome = await ScriptedChrome.start();
      chrome.handle('Page.bringToFront', () => {});
      chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
      chrome.handle('DOM.resolveNode', () => ({ object: { type: 'object', objectId: 'node' } }));
      chrome.handle('Runtime.callFunctionOn', () => ({ result: { type: 'boolean', value: true } }));
      chrome.handle('Runtime.releaseObjectGroup', () => {});
      const sent = gate(),
        reply = gate();
      chrome.handle('Input.insertText', async () => {
        sent.resolve();
        await reply.promise;
      });
      await using browser = await chrome.connect();
      const tab = browser.tabs[0]!;
      const element = new Element(tab.mainFrame, 1, tab.mainFrame.generation, tab.session);
      const pending = (
        input === 'element'
          ? element.fill('once')
          : input === 'composition'
            ? tab.keyboard.compose(async () => {
                await tab.keyboard.insertText('once');
              })
            : tab.keyboard.insertText('once')
      ).catch((error: unknown) => error);
      await sent.promise;
      await change(chrome, tab.session, 'unrelated-child', kind, tab.mainFrame.id);
      reply.resolve();
      assert.ok(!((await pending) instanceof Error));
      assert.equal(tab.inputBehavior.lastReport!.status, 'completed');
      assert.equal(chrome.commands.filter((c) => c.method === 'Input.insertText').length, 1);
    });
  }

  for (const affected of ['main', 'element', 'ancestor', 'separate-session'] as const) {
    test(`input interrupts on ${affected} frame ${kind} before its pending ACK`, async () => {
      await using chrome = await ScriptedChrome.start();
      chrome.handle('Page.bringToFront', () => {});
      const sent = gate(),
        reply = gate();
      chrome.handle('DOM.scrollIntoViewIfNeeded', async () => {
        sent.resolve();
        await reply.promise;
      });
      await using browser = await chrome.connect();
      const tab = browser.tabs[0]!;
      const parent = new Frame(tab.framesManager, 'parent', tab.session);
      parent.parentId = tab.mainFrame.id;
      tab.framesManager.frames.set(parent.id, parent);
      const childSession =
        affected === 'separate-session' ? await browser.attachSession(tab.id) : tab.session;
      tab.framesManager.track(childSession);
      const child = new Frame(tab.framesManager, 'child', childSession);
      child.parentId = parent.id;
      tab.framesManager.frames.set(child.id, child);
      const element = new Element(child, 1, child.generation, childSession);
      const pending = element.click().catch((error: unknown) => error);
      await sent.promise;
      const frame = affected === 'main' ? tab.mainFrame : affected === 'ancestor' ? parent : child;
      await change(chrome, frame.session, frame.id, kind, frame.parentId);
      const error = await pending;
      assert.ok(error instanceof InputActionError);
      assert.ok(error.cause instanceof StaleElementError);
      assert.equal(error.report.cleanup, 'pending');
      reply.resolve();
      assert.equal((await error.cleanup).status, 'completed');
      assert.equal(chrome.commands.filter((c) => c.method.startsWith('Input.')).length, 0);
    });
  }
}
