import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo, type Socket } from 'node:net';
import {
  Browser,
  resolveProxyEnvironment,
  TimeoutError,
  type LaunchOptions,
} from '../../src/index.ts';
import { nativeEnvironment, nativeVariables } from '../../src/optional/native-environment.ts';
import { checkNativeSamples } from '../../src/optional/native-verification.ts';
import { ScriptedChrome } from '../../src/testing/index.ts';
import { BrowserProcess } from '../../src/browser/launcher.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';
import { Script } from 'node:vm';
import { poll } from '../../src/utils.ts';

test('native environment validates platforms and creates child-only variables', async () => {
  const variables = () => ['TZ', 'LANG', 'LANGUAGE', 'LC_ALL'].map((key) => process.env[key]);
  const before = variables();
  const native = nativeEnvironment({ timezone: 'Europe/Paris', locale: 'fr-fr' }, 'linux');
  assert.deepEqual(native, { timezone: 'Europe/Paris', locale: 'fr-FR' });
  assert.deepEqual(nativeVariables(native), {
    TZ: 'Europe/Paris',
    LANG: 'fr_FR.UTF-8',
    LC_ALL: 'fr_FR.UTF-8',
    LANGUAGE: 'fr-FR',
  });
  assert.deepEqual(variables(), before);
  assert.throws(() => nativeEnvironment(native, 'win32'), /requires Linux/);
  assert.throws(() => nativeEnvironment({ ...native, timezone: '../../etc/passwd' }, 'linux'));
  assert.throws(() => nativeEnvironment({ ...native, locale: 'en-US-u-ca-chinese' }, 'linux'));
  // The name is kept as given, even where Node's ICU reports a legacy alias (Europe/Kiev).
  assert.equal(
    nativeEnvironment({ timezone: 'Europe/Kyiv', locale: 'uk-UA' }, 'linux').timezone,
    'Europe/Kyiv',
  );
  assert.throws(() => nativeEnvironment({ ...native, timezone: 'Mars/Olympus' }, 'linux'));
  for (const locale of ['fr', 'zh-Hans-CN', 'es-419', 'not a locale'])
    assert.throws(() => nativeEnvironment({ ...native, locale }, 'linux'), /language-region/);
  if (process.platform !== 'linux')
    await assert.rejects(
      Browser.launch({
        executablePath: process.execPath,
        nativeEnvironment: native,
        prepareProfile: () => {
          throw new Error('must not reach preparation');
        },
      }),
      /requires Linux/,
    );
});

test('native verification rejects missing Worker evidence and cross-context mismatches', () => {
  const expected = { timezone: 'Europe/Paris', locale: 'fr-FR' };
  const sample = { ...expected, language: 'fr-FR', languages: ['fr-FR', 'fr'] };
  const samples = { document: sample, dedicated: sample, shared: sample, service: sample };
  assert.doesNotThrow(() => checkNativeSamples(samples, expected));
  for (const scope of ['document', 'dedicated', 'shared', 'service']) {
    assert.throws(
      () => checkNativeSamples({ ...samples, [scope]: undefined }, expected),
      new RegExp(scope),
    );
    assert.throws(
      () => checkNativeSamples({ ...samples, [scope]: { ...sample, timezone: 'UTC' } }, expected),
      new RegExp(scope),
    );
    assert.throws(() =>
      checkNativeSamples({ ...samples, [scope]: { ...sample, languages: ['en-US'] } }, expected),
    );
  }
  assert.throws(() => checkNativeSamples({ error: 'Worker refused' }, expected), /Worker refused/);
});
test('native verification accepts zone aliases and a UI locale without region shared by every context', () => {
  const expected = { timezone: 'Europe/Kyiv', locale: 'uk-UA' };
  const sample = {
    timezone: 'Europe/Kiev',
    locale: 'uk',
    language: 'uk-UA',
    languages: ['uk-UA', 'uk'],
  };
  const samples = { document: sample, dedicated: sample, shared: sample, service: sample };
  assert.doesNotThrow(() => checkNativeSamples(samples, expected));
  assert.throws(
    () => checkNativeSamples({ ...samples, shared: { ...sample, locale: 'uk-UA' } }, expected),
    /shared/,
  );
  assert.throws(
    () => checkNativeSamples({ ...samples, dedicated: { ...sample, locale: 'ru' } }, expected),
    /dedicated/,
  );
  // The first language matches, the list does not.
  assert.throws(
    () =>
      checkNativeSamples({ ...samples, service: { ...sample, languages: ['uk-UA'] } }, expected),
    /service/,
  );
});
test('Geo preflight goes only through its proxy, rejects redirects and malformed replies, and aborts', async () => {
  const seen: string[] = [];
  let mode = 'ok';
  const server = createServer((req, res) => {
    seen.push(req.url!);
    if (mode === 'hang') return;
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://direct.invalid/' });
      res.end();
      return;
    }
    res.end(
      mode === 'bad'
        ? '{}'
        : mode === 'huge'
          ? ' '.repeat(70000)
          : JSON.stringify({ timezone: 'Asia/Singapore' }),
    );
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const proxy = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const options = { endpoint: 'http://geo.invalid/json', locale: 'en-SG' };
    assert.deepEqual(await resolveProxyEnvironment(proxy, options), {
      timezone: 'Asia/Singapore',
      locale: 'en-SG',
    });
    assert.deepEqual(seen, [options.endpoint]);
    for (const [value, message] of [
      ['redirect', /HTTP 302/],
      ['bad', /timezone: string/],
      ['huge', /64 KiB/],
    ] as const) {
      mode = value;
      await assert.rejects(resolveProxyEnvironment(proxy, options), message);
    }
    mode = 'hang';
    await assert.rejects(resolveProxyEnvironment(proxy, options, { timeout: 30 }), TimeoutError);
    const controller = new AbortController();
    const stop = new Error('stop');
    controller.abort(stop);
    await assert.rejects(
      resolveProxyEnvironment(proxy, options, { signal: controller.signal }),
      (e) => e === stop,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test('Geo preflight to an HTTPS endpoint settles when the proxy stalls the tunnel, and closes it', async () => {
  const sockets: Socket[] = [];
  let connected: (() => void) | undefined;
  // Accepts CONNECT and never answers it.
  const proxy = createTcpServer((socket) => {
    sockets.push(socket);
    socket.resume();
    connected?.();
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const options = { endpoint: 'https://geo.invalid/json', locale: 'en-SG' };
    await assert.rejects(resolveProxyEnvironment(url, options, { timeout: 200 }), TimeoutError);
    const controller = new AbortController();
    const stop = new Error('stop');
    connected = () => controller.abort(stop);
    await assert.rejects(
      resolveProxyEnvironment(url, options, { signal: controller.signal }),
      (e) => e === stop,
    );
    assert.equal(sockets.length, 2);
    await poll(async () => sockets.every((s) => s.closed) || undefined, { timeout: 2000 });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((r) => proxy.close(() => r()));
  }
});

test('native launch options are checked before the proxy or the host is consulted', async () => {
  let contacted = 0;
  const server = createServer((_, res) => {
    contacted++;
    res.end(JSON.stringify({ timezone: 'Europe/Paris' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  try {
    const proxyServer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const nativeEnvironment = { timezone: 'Europe/Paris', locale: 'fr-FR' };
    const autoAlignEnv = { endpoint: 'http://geo.invalid/json', locale: 'fr-FR' };
    const cases: Array<[LaunchOptions, RegExp]> = [
      [{ nativeEnvironment, autoAlignEnv }, /Choose nativeEnvironment or autoAlignEnv/],
      [{ nativeEnvironment, attach: 'none' }, /page attachment/],
      [{ nativeEnvironment, lang: 'de-DE' }, /conflicts/],
      [{ nativeEnvironment, args: ['--lang=de'] }, /conflicts/],
      [{ nativeEnvironment, env: { TZ: 'UTC' } }, /conflicts/],
      [{ nativeEnvironment, maskHeadless: true }, /conflicts/],
      [{ autoAlignEnv }, /requires one proxyServer/],
      [{ autoAlignEnv, proxyServer, proxyBypassList: 'localhost' }, /requires one proxyServer/],
      [{ autoAlignEnv, proxyServer, args: ['--proxy-pac-url=data:,'] }, /requires one proxyServer/],
      [{ autoAlignEnv, proxyServer: proxyServer.replace('//', '//user:pass@') }, /ProxyForwarder/],
      [{ autoAlignEnv, proxyServer, windowSize: { width: 0, height: 600 } }, /Invalid windowSize/],
      [
        { autoAlignEnv, proxyServer, args: ['--enable-blink-features=AutomationControlled'] },
        /automationControlled: true/,
      ],
    ];
    for (const [options, message] of cases)
      await assert.rejects(
        BrowserProcess.start({
          executablePath: process.execPath,
          prepareProfile: () => {
            throw new Error('must not reach preparation');
          },
          ...options,
        }),
        message,
      );
    assert.equal(contacted, 0);
  } finally {
    Object.defineProperty(process, 'platform', platform);
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

for (const mode of ['ok', 'mismatch', 'header', 'stalled'] as const) {
  test(`native startup probe ${mode}: validates before returning and removes its owned page/server`, async (t) => {
    await using chrome = await ScriptedChrome.start();
    let closed = 0;
    t.mock.method(BrowserProcess, 'start', async () => ({
      endpoint: chrome.endpoint,
      transport: await WebSocketTransport.connect(chrome.endpoint),
      nativeEnvironment: { timezone: 'Europe/Paris', locale: 'fr-FR' },
      process: {
        released: false,
        diagnostics: { exited: false },
        captureDiagnostics: async () => {},
        waitForExit: async () => true,
        close: async () => {
          closed++;
        },
      },
    }));
    chrome.handle('Browser.close', () => {});
    let pageURL = '',
      pageId = '';
    chrome.handle('Page.navigate', async (params, command) => {
      pageURL = params.url;
      const attach = chrome.commands.findLast((c) => c.method === 'Target.attachToTarget');
      pageId = (attach!.params as { targetId: string }).targetId;
      const headers = { 'accept-language': mode === 'header' ? 'en-US' : 'fr-FR,fr;q=0.9' };
      const html = await (await fetch(pageURL, { headers })).text();
      new Script(html.split('<script>')[1]!.split('</script>')[0]!);
      for (const worker of ['dedicated', 'shared', 'service']) {
        new Script(await (await fetch(new URL(`${worker}.js`, pageURL))).text());
      }
      if (mode !== 'stalled') {
        const sample = {
          timezone: 'Europe/Paris',
          locale: 'fr-FR',
          language: 'fr-FR',
          languages: ['fr-FR', 'fr'],
        };
        const service = mode === 'mismatch' ? { ...sample, timezone: 'UTC' } : sample;
        await fetch(new URL('report', pageURL), {
          method: 'POST',
          headers: { origin: new URL(pageURL).origin },
          body: JSON.stringify({ document: sample, dedicated: sample, shared: sample, service }),
        });
      }
      chrome.emit(
        'Page.frameNavigated',
        {
          type: 'Navigation',
          frame: {
            id: pageId,
            loaderId: 'probe',
            url: pageURL,
            domainAndRegistry: '',
            securityOrigin: new URL(pageURL).origin,
            mimeType: 'text/html',
            secureContextType: 'SecureLocalhost',
            crossOriginIsolatedContextType: 'NotIsolated',
            gatedAPIFeatures: [],
          },
        },
        command.sessionId,
      );
      chrome.emit(
        'Page.lifecycleEvent',
        { frameId: pageId, loaderId: 'probe', name: 'load', timestamp: 0 },
        command.sessionId,
      );
      return { frameId: pageId, loaderId: 'probe' };
    });
    const launch = Browser.launch({ attach: 'created', timeout: mode === 'stalled' ? 350 : 3000 });
    if (mode === 'ok') {
      const browser = await launch;
      assert.ok(!browser.tabs.some((tab) => tab.id === pageId));
      await browser.close();
    } else
      await assert.rejects(
        launch,
        mode === 'stalled' ? /timed out/ : /Native environment verification failed/,
      );
    assert.equal(closed, 1);
    assert.ok(
      chrome.commands.some(
        (c) =>
          c.method === 'Target.closeTarget' &&
          (c.params as { targetId: string }).targetId === pageId,
      ),
    );
    await assert.rejects(fetch(pageURL));
    assert.ok(
      !chrome.commands.some(
        (c) => c.method.startsWith('Emulation.') || c.method === 'Runtime.enable',
      ),
    );
  });
}
