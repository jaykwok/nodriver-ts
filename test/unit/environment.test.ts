import { expect, spyOn, test } from 'bun:test';
import { Frame, type FrameManager } from '../../src/page/frames.js';
import { Connection } from '../../src/protocol/connection.js';
import { StaleElementError, TimeoutError } from '../../src/errors.js';

test('environment sampling rejects navigation between document and Worker without replay', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const frame = new Frame({} as FrameManager, 'frame', connection.session('page'));
  const evaluate = spyOn(frame, 'evaluate');
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
    await connection.close();
  }
});

test('environment budget/abort checks run before any browser commands; UA-CH key order is ignored', async () => {
  const connection = new Connection({ send() {}, close() {} });
  const frame = new Frame({} as FrameManager, 'frame', connection.session('page'));
  const evaluate = spyOn(frame, 'evaluate');
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
    await connection.close();
  }
});
