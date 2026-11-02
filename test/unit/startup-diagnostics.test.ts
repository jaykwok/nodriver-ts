import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Browser, TimeoutError, getStartupDiagnostics } from '../../src/index.ts';
import { BrowserProcess } from '../../src/browser/launcher.ts';
import { WebSocketTransport } from '../../src/transport/websocket.ts';
import { NO_REPLY, ScriptedChrome } from '../../src/testing/index.ts';

test('launch failure reports exited child, PID and bounded stderr, including detached discard status', async () => {
  for (const detached of [false, true]) {
    await assert.rejects(
      Browser.launch({ executablePath: process.execPath, detached, timeout: 3000 }),
      (error) => {
        const info = getStartupDiagnostics(error)!;
        assert.equal(info.stage, 'port-file');
        assert.ok(info.elapsedMs >= info.stageElapsedMs);
        assert.ok(info.process!.pid! > 0);
        assert.equal(info.process!.exited, true);
        assert.notEqual(info.process!.exitCode, null);
        assert.equal(info.process!.stderrStatus, detached ? 'discarded' : 'captured');
        assert.ok(info.process!.stderr.length <= 16384);
        if (!detached) assert.match(info.process!.stderr, /bad option|unknown option/i);
        assert.match((error as Error).message, /startup stage=port-file/);
        return true;
      },
    );
  }
});

test('executable lookup failure identifies process launch without inventing a PID', async () => {
  await assert.rejects(
    Browser.launch({ executablePath: '/nodriver-missing-executable-7a6ea' }),
    (error) => {
      assert.equal(getStartupDiagnostics(error)?.stage, 'process-launch');
      assert.equal(getStartupDiagnostics(error)?.process, undefined);
      return true;
    },
  );
});

test('supervised detached startup failure retains stderr rather than discarding it', async () => {
  await assert.rejects(
    Browser.launch({
      executablePath: process.execPath,
      detached: true,
      supervised: true,
      timeout: 10000,
    }),
    (error) => {
      const info = getStartupDiagnostics(error)!;
      assert.equal(info.stage, 'port-file');
      assert.equal(info.process?.stderrStatus, 'captured');
      assert.match(info.process!.stderr, /bad option|unknown option/i);
      assert.ok(info.process!.stderr.length <= 16384);
      return true;
    },
  );
});

test('endpoint discovery and WebSocket failures have distinct phases', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    for (const [scheme, stage] of [
      ['http', 'endpoint-discovery'],
      ['ws', 'websocket-connect'],
    ]) {
      await assert.rejects(
        Browser.connect({ endpoint: `${scheme}://127.0.0.1:${address.port}`, timeout: 1000 }),
        (error) => {
          assert.equal(getStartupDiagnostics(error)?.stage, stage);
          assert.equal(getStartupDiagnostics(error)?.process, undefined);
          return true;
        },
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('handshake and target initialization timeouts retain TimeoutError with stage diagnostics', async () => {
  for (const method of ['Browser.getVersion', 'Target.getTargets'] as const) {
    await using chrome = await ScriptedChrome.start();
    chrome.handle(method, () => NO_REPLY);
    await assert.rejects(chrome.connect({ attach: 'none', timeout: 100 }), (error) => {
      assert.ok(error instanceof TimeoutError);
      assert.equal(
        getStartupDiagnostics(error)?.stage,
        method === 'Browser.getVersion' ? 'protocol-handshake' : 'target-initialization',
      );
      assert.match(error.message, /startup stage=/);
      return true;
    });
  }
});

test('frozen caller cancellation keeps identity; process snapshot precedes failure cleanup', async (t) => {
  await using chrome = await ScriptedChrome.start();
  let closed = false;
  t.mock.method(BrowserProcess, 'start', async () => ({
    transport: await WebSocketTransport.connect(chrome.endpoint),
    process: {
      get diagnostics() {
        return {
          pid: 123,
          exited: closed,
          exitCode: null,
          signal: null,
          stderr: 'startup evidence',
          stderrStatus: 'captured',
        };
      },
      async captureDiagnostics() {},
      async close() {
        closed = true;
      },
    },
  }));
  const controller = new AbortController();
  const reason = Object.freeze(new Error('caller cancellation'));
  chrome.handle('Target.getTargets', () => {
    controller.abort(reason);
    return NO_REPLY;
  });
  await assert.rejects(Browser.launch({ attach: 'none', signal: controller.signal }), (error) => {
    assert.equal(error, reason);
    assert.equal(reason.message, 'caller cancellation');
    const info = getStartupDiagnostics(error)!;
    assert.equal(info.stage, 'target-initialization');
    assert.equal(info.process?.exited, false);
    assert.equal(info.process?.stderr, 'startup evidence');
    assert.equal(closed, true);
    return true;
  });
});
