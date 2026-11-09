import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { expect } from '../fixtures/expect.ts';
import { spyOn } from 'jest-mock';
import { Frame, type FrameManager } from '../../src/page/frames.ts';
import { Connection } from '../../src/protocol/connection.ts';
import { ProtocolError, StaleElementError, TimeoutError } from '../../src/errors.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import type { Tab } from '../../src/page/tab.ts';
import { poll } from '../../src/utils.ts';

test('environment sampling rejects navigation between document and Worker without replay', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const frame = new Frame({} as FrameManager, 'frame', connection.session('page'));
  const evaluate = spyOn(frame, 'evaluate');
  const context = spyOn(frame, 'context').mockResolvedValue(1);
  evaluate.mockResolvedValueOnce({ userAgent: 'document' });
  evaluate.mockImplementationOnce(async <T>() => {
    frame.invalidate();
    return { status: 'ok', navigator: { userAgent: 'worker' } } as T;
  });
  try {
    await expect(frame.inspectEnvironment({ worker: true })).rejects.toBeInstanceOf(
      StaleElementError,
    );
    expect(evaluate).toHaveBeenCalledTimes(2);
  } finally {
    evaluate.mockRestore();
    context.mockRestore();
    await connection.close();
  }
});

test('environment budget/abort checks run before any browser commands; UA-CH key order is ignored', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const frame = new Frame({} as FrameManager, 'frame', connection.session('page'));
  const evaluate = spyOn(frame, 'evaluate');
  const context = spyOn(frame, 'context').mockResolvedValue(1);
  try {
    await expect(frame.inspectEnvironment({ timeout: 0 })).rejects.toBeInstanceOf(TimeoutError);
    const controller = new AbortController();
    controller.abort(new Error('cancel sampling'));
    await expect(frame.inspectEnvironment({ signal: controller.signal })).rejects.toThrow(
      'cancel sampling',
    );
    expect(evaluate).toHaveBeenCalledTimes(0);
    evaluate.mockResolvedValueOnce({
      userAgent: 'same',
      userAgentData: { mobile: false, brands: [] },
    });
    evaluate.mockResolvedValueOnce({
      status: 'ok',
      navigator: { userAgent: 'same', userAgentData: { brands: [], mobile: false } },
    });
    expect((await frame.inspectEnvironment({ worker: true })).differences).toEqual([]);
  } finally {
    evaluate.mockRestore();
    context.mockRestore();
    await connection.close();
  }
});

test('a document that goes away during sampling is stale, with the protocol error as cause', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const frame = new Frame({} as FrameManager, 'frame', connection.session('page'));
  const evaluate = spyOn(frame, 'evaluate');
  const context = spyOn(frame, 'context').mockResolvedValue(1);
  try {
    const navigated = new ProtocolError(
      'Runtime.evaluate',
      -32000,
      'Inspected target navigated or closed',
    );
    evaluate.mockRejectedValueOnce(navigated);
    const document = await frame.inspectEnvironment().catch((error: unknown) => error);
    expect(document).toBeInstanceOf(StaleElementError);
    expect((document as Error).cause).toBe(navigated);

    const destroyed = new ProtocolError(
      'Runtime.callFunctionOn',
      -32000,
      'Execution context was destroyed.',
    );
    evaluate.mockResolvedValueOnce({ userAgent: 'document' });
    evaluate.mockRejectedValueOnce(destroyed);
    const worker = await frame.inspectEnvironment({ worker: true }).catch((e: unknown) => e);
    expect(worker).toBeInstanceOf(StaleElementError);
    expect((worker as Error).cause).toBe(destroyed);

    const unrelated = new ProtocolError('Runtime.evaluate', -32603, 'Internal error');
    evaluate.mockRejectedValueOnce(unrelated);
    await expect(frame.inspectEnvironment()).rejects.toBe(unrelated);
  } finally {
    evaluate.mockRestore();
    context.mockRestore();
    await connection.close();
  }
});

test('Accept-Language alone leaves the UA and UA-CH to Chrome, also on insecure pages', async (t) => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  // An insecure document: navigator.userAgentData is missing.
  t.mock.method(tab, 'inspectEnvironment', async () => ({
    document: { userAgent: 'Mozilla/5.0 Chrome/140' },
  }));
  chrome.handle('Emulation.setUserAgentOverride', () => {});
  await tab.setEnvironment({ acceptLanguage: 'fr-FR,fr', timezone: undefined });
  const sent = chrome.commands.filter((c) => c.method === 'Emulation.setUserAgentOverride');
  expect(sent.map((c) => c.params)).toEqual([{ userAgent: '', acceptLanguage: 'fr-FR,fr' }]);
  expect(tab.environmentState().requested).toEqual({ acceptLanguage: 'fr-FR,fr' });
});

/** Has Chrome attach a cross-origin iframe of the tab in its own session. */
function attachFrame(chrome: ScriptedChrome, tab: Tab, sessionId: string) {
  chrome.handle('Page.enable', () => {});
  chrome.handle('Page.getFrameTree', () => ({
    frameTree: {
      frame: {
        id: 'frame',
        parentId: tab.mainFrame.id,
        loaderId: 'loader',
        url: 'https://other.test/',
        domainAndRegistry: 'other.test',
        securityOrigin: 'https://other.test',
        mimeType: 'text/html',
        secureContextType: 'Secure',
        crossOriginIsolatedContextType: 'NotIsolated',
        gatedAPIFeatures: [],
      },
    },
  }));
  chrome.handle('Page.setLifecycleEventsEnabled', () => {});
  chrome.handle('Target.setAutoAttach', () => {});
  chrome.handle('Runtime.runIfWaitingForDebugger', () => {});
  chrome.emit(
    'Target.attachedToTarget',
    {
      sessionId,
      waitingForDebugger: true,
      targetInfo: {
        targetId: 'frame',
        type: 'iframe',
        url: 'https://other.test/',
        title: '',
        attached: true,
        canAccessOpener: false,
      },
    },
    tab.session.id,
  );
}

test('environment changes apply one at a time, and waiting spends the budget', async (t) => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  t.mock.method(tab, 'inspectEnvironment', async () => ({}));
  // Paris and Accept-Language are never answered: those changes run until they are aborted.
  chrome.handle('Emulation.setTimezoneOverride', ({ timezoneId }) =>
    timezoneId === 'Europe/Paris' ? NO_REPLY : undefined,
  );
  chrome.handle('Emulation.setUserAgentOverride', () => NO_REPLY);
  await tab.setEnvironment({ timezone: 'Asia/Tokyo' });
  const sent = (method: string) =>
    chrome.commands.filter((c) => c.method === method).map((c) => c.params);
  const first = new AbortController();
  const second = new AbortController();
  const paris = tab.setEnvironment({ timezone: 'Europe/Paris' }, { signal: first.signal });
  const language = tab.setEnvironment({ acceptLanguage: 'fr-FR' }, { signal: second.signal });
  await poll(async () => sent('Emulation.setTimezoneOverride').length === 2 || undefined, {
    timeout: 1000,
  });
  await expect(tab.setEnvironment({ locale: 'fr-FR' }, { timeout: 30 })).rejects.toBeInstanceOf(
    TimeoutError,
  );
  expect(sent('Emulation.setUserAgentOverride')).toEqual([]);
  first.abort(new Error('first cancelled'));
  await expect(paris).rejects.toThrow('first cancelled');
  // The next change starts from the configuration before the cancelled one.
  await poll(async () => sent('Emulation.setUserAgentOverride').length || undefined, {
    timeout: 1000,
  });
  expect(sent('Emulation.setTimezoneOverride').at(-1)).toEqual({ timezoneId: 'Asia/Tokyo' });
  second.abort(new Error('second cancelled'));
  await expect(language).rejects.toThrow('second cancelled');
  expect(tab.environmentState().requested).toEqual({ timezone: 'Asia/Tokyo' });
  expect(sent('Emulation.setLocaleOverride')).toEqual([]);
});

test('a frame attaching during a change that succeeds keeps it past its deadline', async (t) => {
  await using chrome = await ScriptedChrome.start();
  await using browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  t.mock.method(tab, 'inspectEnvironment', async () => ({}));
  chrome.handle('Emulation.setTimezoneOverride', () => {});
  await tab.setEnvironment({ timezone: 'Asia/Tokyo' });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let open = false;
  const frameZones: string[] = [];
  chrome.handle('Emulation.setTimezoneOverride', async ({ timezoneId }, { sessionId }) => {
    if (sessionId === 'frame-session') {
      frameZones.push(timezoneId);
      // An override sent to the frame before the change completes is never answered.
      if (!open) return NO_REPLY;
    } else if (timezoneId === 'Europe/Paris') await released;
  });
  const start = performance.now();
  const applying = tab.setEnvironment({ timezone: 'Europe/Paris' }, { timeout: 250 });
  // The main page's Paris override, after Tokyo, is waiting for its reply.
  const zones = () => chrome.commands.filter((c) => c.method === 'Emulation.setTimezoneOverride');
  await poll(async () => zones().length === 2 || undefined, { timeout: 1000 });
  attachFrame(chrome, tab, 'frame-session');
  // The frame's setup reaches its configuration while the change still runs.
  const autoAttach = () =>
    chrome.commands.some(
      (c) => c.method === 'Target.setAutoAttach' && c.sessionId === 'frame-session',
    );
  await poll(async () => autoAttach() || undefined, { timeout: 1000 });
  await sleep(20);
  open = true;
  release();
  await applying;
  await poll(async () => !tab.framesManager.setup.has('frame-session') || undefined, {
    timeout: 1000,
  });
  await sleep(Math.max(0, start + 300 - performance.now()));
  expect(frameZones).not.toContain('Asia/Tokyo');
  expect(frameZones.at(-1)).toBe('Europe/Paris');
  expect(tab.environmentState().requested.timezone).toBe('Europe/Paris');
});
