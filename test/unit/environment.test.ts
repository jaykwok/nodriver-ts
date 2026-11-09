import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { spyOn } from 'jest-mock';
import { Frame, type FrameManager } from '../../src/page/frames.ts';
import { Connection } from '../../src/protocol/connection.ts';
import { ProtocolError, StaleElementError, TimeoutError } from '../../src/errors.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';

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
