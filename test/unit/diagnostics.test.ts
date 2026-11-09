import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import {
  alignEnvironment,
  diagnoseEnvironment,
  type DiagnoseEnvironmentOptions,
} from '../../src/page/diagnostics.ts';
import type { Tab } from '../../src/page/tab.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';
import { StaleElementError, TimeoutError } from '../../src/errors.ts';
import { poll } from '../../src/utils.ts';

const viewport = { width: 800, height: 600, devicePixelRatio: 1 };
const frame = (frameId: string, document: object = {}, navigator: object = {}) => ({
  frameId,
  document: { viewport, ...document },
  worker: { status: 'ok', navigator },
});
/** Answers the before sample, then `after` for the sample taken once overrides are applied. */
function aligning(after: unknown, applied: { count?: number } = {}) {
  let samples = 0;
  return {
    mainFrame: { id: 'main' },
    diagnoseEnvironment: async (options: DiagnoseEnvironmentOptions) => {
      if (samples++ === 0) return { frames: [] };
      return typeof after === 'function' ? await after(options) : after;
    },
    setEnvironment: async () => {
      applied.count = (applied.count ?? 0) + 1;
    },
  } as unknown as Tab;
}

test('GeoIP resolver is opt-in and bounded; cancellation never applies a late result', async () => {
  let applied = 0;
  const tab = {
    diagnoseEnvironment: async () => ({ frames: [] }),
    setEnvironment: async () => {
      applied++;
    },
  } as unknown as Tab;
  await expect(
    alignEnvironment(tab, { geoip: { address: 'local-fixture', fields: ['timezone'] } }),
  ).rejects.toThrow('caller-supplied');
  const deadline = alignEnvironment(
    tab,
    { geoip: { address: 'local-fixture', fields: ['timezone'] }, timeout: 20 },
    async () => new Promise(() => {}),
  );
  await expect(deadline).rejects.toThrow('deadline');
  await expect(deadline).rejects.toBeInstanceOf(TimeoutError);
  expect(applied).toBe(0);
});

test('viewport verification covers the main frame only', async () => {
  const child = { viewport: { width: 100, height: 50, devicePixelRatio: 1 }, timezone: 'UTC' };
  const after = {
    frames: [frame('child', child, { timezone: 'UTC' }), frame('main', {}, { timezone: 'UTC' })],
  };
  const { verification } = await alignEnvironment(aligning(after), {
    environment: { timezone: 'UTC', viewport: { width: 800, height: 600 } },
  });
  expect(verification.filter((v) => v.field === 'viewport')).toEqual([
    {
      field: 'viewport',
      scope: 'main/document',
      expected: viewport,
      actual: viewport,
      status: 'match',
    },
    {
      field: 'viewport',
      scope: 'main/worker',
      expected: viewport,
      actual: undefined,
      status: 'unavailable',
    },
  ]);
  expect(
    verification.filter((v) => v.field === 'timezone' && v.scope.startsWith('child/')),
  ).toHaveLength(2);
  const wrong = await alignEnvironment(aligning(after), {
    environment: { viewport: { width: 801, height: 600 } },
  });
  expect(wrong.verification[0]!.status).toBe('mismatch');
});

test('Accept-Language compares ordered tags and keeps the raw values in the report', async () => {
  const cases: Array<[string, unknown, string]> = [
    ['fr-FR,fr', 'fr-FR,fr;q=0.9', 'match'],
    ['fr-FR', 'fr-FR', 'match'],
    ['fr-fr, FR', 'fr-FR, fr;q=0.9', 'match'],
    // Chrome keeps weights the caller wrote and appends its own.
    ['fr-FR,en;q=0.5', 'fr-FR,en;q=0.5;q=0.9', 'match'],
    ['fr,*', 'fr,*;q=0.9', 'match'],
    ['fr,en', 'en,fr;q=0.9', 'mismatch'],
    ['fr,en', 'fr', 'mismatch'],
    ['fr,en', null, 'mismatch'],
    ['fr,en', undefined, 'not-tested'],
  ];
  for (const [acceptLanguage, header, status] of cases) {
    const after = { frames: [], http: { value: { headers: { 'accept-language': header } } } };
    const { verification } = await alignEnvironment(aligning(after), {
      environment: { acceptLanguage },
    });
    expect(verification).toEqual([
      { field: 'acceptLanguage', scope: 'HTTP', expected: acceptLanguage, actual: header, status },
    ]);
  }
  const unmeasured = await alignEnvironment(aligning({ frames: [], http: {} }), {
    environment: { acceptLanguage: 'fr' },
  });
  expect(unmeasured.verification[0]!.status).toBe('not-tested');
});

test('locale and timezone compare canonical forms; values Intl refuses cannot lose the report', async () => {
  const after = {
    frames: [
      frame(
        'main',
        { intlLocale: 'fr-FR', timezone: 'Asia/Calcutta' },
        { intlLocale: 'de-DE', timezone: 'UTC' },
      ),
    ],
  };
  const canonical = await alignEnvironment(aligning(after), {
    environment: { locale: 'fr-fr', timezone: 'Asia/Kolkata' },
  });
  expect(
    canonical.verification.map((v) => [v.field, v.scope, v.expected, v.actual, v.status]),
  ).toEqual([
    ['timezone', 'main/document', 'Asia/Kolkata', 'Asia/Calcutta', 'match'],
    ['timezone', 'main/worker', 'Asia/Kolkata', 'UTC', 'mismatch'],
    ['locale', 'main/document', 'fr-fr', 'fr-FR', 'match'],
    ['locale', 'main/worker', 'fr-fr', 'de-DE', 'mismatch'],
  ]);
  const refused = await alignEnvironment(aligning(after), {
    environment: { locale: 'not a locale', timezone: 'Not/AZone' },
  });
  expect(refused.verification.map((v) => v.status)).toEqual([
    'mismatch',
    'mismatch',
    'mismatch',
    'mismatch',
  ]);
});

test('unusable probes reject before sampling or applying anything', async () => {
  const invalid: DiagnoseEnvironmentOptions[] = [
    { httpProbe: 'not a url' },
    { httpProbe: 'ftp://probe.test/' },
    { httpProbe: 'http://user:pass@probe.test/' },
    { stunServers: ['turn:relay.test'] },
    { stunServers: ['stun:a', 'stun:b', 'stun:c', 'stun:d', 'stun:e'] },
    { fontSelectors: Array.from({ length: 17 }, () => 'body') },
  ];
  for (const inspect of invalid) {
    const applied: { count?: number } = {};
    let samples = 0;
    const tab = {
      ...aligning({}, applied),
      diagnoseEnvironment: async () => void samples++,
      get frames() {
        samples++;
        return [];
      },
    } as unknown as Tab;
    await expect(alignEnvironment(tab, { inspect })).rejects.toThrow();
    await expect(diagnoseEnvironment(tab, inspect)).rejects.toThrow();
    expect(samples).toBe(0);
    expect(applied.count).toBeUndefined();
  }
});

test('a failed after-sample stays in the report; only the caller abort rejects', async () => {
  const applied: { count?: number } = {};
  const stale = await alignEnvironment(
    aligning(() => {
      throw new StaleElementError('Document changed during diagnostics');
    }, applied),
    { environment: { timezone: 'Europe/Paris', locale: undefined } },
  );
  expect(applied.count).toBe(1);
  expect(stale.before).toEqual({ frames: [] });
  expect(stale.after).toBeUndefined();
  expect(stale.verificationError).toContain('Document changed');
  expect(stale.verification).toEqual([
    { field: 'timezone', scope: 'tab', status: 'not-tested', expected: 'Europe/Paris' },
  ]);

  // The alignment's own deadline is a measured outcome, not a caller decision.
  const expired = await alignEnvironment(
    aligning(
      ({ signal }: DiagnoseEnvironmentOptions) =>
        new Promise((_, reject) =>
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }),
        ),
    ),
    { environment: { timezone: 'Europe/Paris' }, timeout: 20 },
  );
  expect(expired.verificationError).toContain('TimeoutError: Alignment deadline exceeded');

  const controller = new AbortController();
  await expect(
    alignEnvironment(
      aligning(() => {
        controller.abort(new Error('cancel alignment'));
        throw controller.signal.reason;
      }),
      { signal: controller.signal },
    ),
  ).rejects.toThrow('cancel alignment');
});

test('a spent diagnostic deadline is a TimeoutError', async () => {
  const tab = {
    mainFrame: { generation: 0, detached: false },
    frames: [{}],
  } as unknown as Tab;
  await expect(diagnoseEnvironment(tab, { timeout: 0 })).rejects.toBeInstanceOf(TimeoutError);
});

async function fontTab() {
  const chrome = await ScriptedChrome.start();
  const browser = await chrome.connect();
  const tab = browser.tabs[0]!;
  chrome.handle('Page.createIsolatedWorld', () => ({ executionContextId: 8 }));
  chrome.handle('Runtime.evaluate', () => ({
    result: { type: 'object', value: { userAgent: 'scripted' } },
  }));
  chrome.handle('DOM.enable', () => undefined);
  chrome.handle('CSS.enable', () => undefined);
  chrome.handle('Runtime.releaseObjectGroup', () => undefined);
  // The temporary probe session answers; the query on the frame's own session never does.
  chrome.handle('DOM.getDocument', (_, command) =>
    command.sessionId === tab.session.id ? NO_REPLY : { root: {} as never },
  );
  const dispose = async () => {
    await browser.close();
    await chrome.close();
  };
  return { chrome, tab, dispose };
}

test('font probes spend the caller budget and leave no attachment behind', async () => {
  const { chrome, tab, dispose } = await fontTab();
  try {
    await expect(
      tab.diagnoseEnvironment({ fontSelectors: ['body'], timeout: 100 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(chrome.commands.filter((c) => c.method === 'Target.detachFromTarget')).toHaveLength(1);
    chrome.assertDone();
  } finally {
    await dispose();
  }
});

test('font probes stop at the caller signal', async () => {
  const { chrome, tab, dispose } = await fontTab();
  try {
    const controller = new AbortController();
    const pending = tab.diagnoseEnvironment({
      fontSelectors: ['body'],
      signal: controller.signal,
    });
    await poll(
      async () =>
        chrome.commands.some(
          (c) => c.method === 'DOM.getDocument' && c.sessionId === tab.session.id,
        ) || undefined,
      { timeout: 2000 },
      'font query',
    );
    controller.abort(new Error('cancel fonts'));
    await expect(pending).rejects.toThrow('cancel fonts');
    expect(chrome.commands.filter((c) => c.method === 'Target.detachFromTarget')).toHaveLength(1);
  } finally {
    await dispose();
  }
});

test('an unanswered font probe detach cannot hold the diagnostic', async () => {
  const { chrome, tab, dispose } = await fontTab();
  try {
    chrome.replyOnce('Target.detachFromTarget', () => NO_REPLY);
    const started = performance.now();
    await expect(
      tab.diagnoseEnvironment({ fontSelectors: ['body'], timeout: 100 }),
    ).rejects.toBeInstanceOf(TimeoutError);
    expect(performance.now() - started).toBeLessThan(3000);
    await poll(
      async () =>
        chrome.commands.filter((c) => c.method === 'Target.detachFromTarget').length === 2 ||
        undefined,
      { timeout: 2000 },
      'independent detach cleanup',
    );
    chrome.assertDone();
  } finally {
    await dispose();
  }
});

test('alignment applies overrides within its deadline and reports a stalled application', async () => {
  const tab = {
    mainFrame: { id: 'main' },
    diagnoseEnvironment: async () => ({ frames: [] }),
    setEnvironment: () => new Promise(() => {}),
  } as unknown as Tab;
  const started = performance.now();
  const report = await alignEnvironment(tab, {
    environment: { timezone: 'Europe/Berlin' },
    timeout: 100,
  });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(report.applicationError).toMatch(/deadline exceeded|timed out/);
});
