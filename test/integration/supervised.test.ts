import assert from 'node:assert/strict';
import { test } from 'node:test';
import { access, mkdtemp, readdir, utimes } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, getStartupDiagnostics } from '../../src/index.ts';
import { bounded, poll, removeTree } from '../../src/utils.ts';
import { sweepHelperDirectories } from '../../src/browser/guardian.ts';

test('supervised Chrome release keeps profile and reconnects after helper control closes', async () => {
  const browser = await Browser.launch({
    headless: true,
    attach: 'none',
    detached: true,
    supervised: true,
  });
  const profile = browser.process!.profile;
  let remote: Browser | undefined;
  try {
    const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
    const session = await browser.attachSession(targetId);
    assert.equal((await session.send('Runtime.evaluate', { expression: '6*7' })).result.value, 42);
    assert.equal(browser.process!.diagnostics.stderrStatus, 'captured');
    assert.notEqual(browser.process!.pid, browser.process!.child.pid);
    const release = browser.release();
    assert.equal(browser.release(), release);
    await browser.close();
    assert.equal(await release, browser.endpoint);
    await browser.process!.close();
    assert.equal(browser.owned, false);
    await access(profile);
    remote = await Browser.connect({ endpoint: browser.endpoint!, attach: 'none' });
    assert.ok(remote.pageTargets.length > 0);
  } finally {
    if (browser.process!.released) {
      remote ??= await Browser.connect({ endpoint: browser.endpoint!, attach: 'none' });
      await remote.cdp.send('Browser.close').catch(() => {});
      await remote.close();
      assert.equal(await browser.process!.waitForExit(10000), true);
      await removeTree(profile);
    } else await browser.close();
  }
});

test(
  'the helper sweep keeps the directory of a running helper, and close removes it',
  { skip: process.platform !== 'win32' && 'Only the Windows helper is compiled into a directory' },
  async () => {
    const helpers = async () =>
      new Set((await readdir(tmpdir())).filter((name) => name.startsWith('nodriver-guardian-')));
    const before = await helpers();
    const browser = await Browser.launch({ headless: true, detached: true, supervised: true });
    try {
      const [name] = [...(await helpers())].filter((name) => !before.has(name));
      assert.ok(name);
      const directory = join(tmpdir(), name);
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(directory, old, old);
      await sweepHelperDirectories();
      await access(join(directory, 'guardian.exe'));
      assert.ok((await browser.cdp.send('Browser.getVersion')).product);
      await browser.close();
      await assert.rejects(access(directory), { code: 'ENOENT' });
    } finally {
      await browser.close();
    }
  },
);

test('supervised launch cancellation during handshake cleans the owned process', async () => {
  const controller = new AbortController();
  const reason = new Error('stop supervised initialization');
  await assert.rejects(
    Browser.launch({
      headless: true,
      detached: true,
      supervised: true,
      signal: controller.signal,
      observe: {
        onSend(event) {
          if (event.method === 'Browser.getVersion') controller.abort(reason);
        },
      },
    }),
    (error) => {
      assert.equal(error, reason);
      const diagnostics = getStartupDiagnostics(error)!;
      assert.equal(diagnostics.stage, 'protocol-handshake');
      assert.equal(diagnostics.process?.stderrStatus, 'captured');
      assert.ok(diagnostics.process!.pid! > 0);
      assert.throws(() => process.kill(diagnostics.process!.pid!, 0), { code: 'ESRCH' });
      return true;
    },
  );
});

test('supervised validates transport and explicit detached ownership before starting a process', async () => {
  await assert.rejects(Browser.launch({ supervised: true }), /requires detached/);
  await assert.rejects(
    Browser.launch({ supervised: true, detached: true, transport: 'pipe' }),
    /WebSocket/,
  );
});

for (const mode of ['owned', 'released', 'natural']) {
  test(`supervised real Chrome: ${mode} host exit`, async () => {
    const profile = await mkdtemp(join(tmpdir(), 'nodriver-supervised-'));
    const host = fork(
      fileURLToPath(new URL('../fixtures/supervised-host.ts', import.meta.url)),
      [profile, mode],
      {
        execArgv: [],
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    let stderr = '';
    host.stderr!.on('data', (data) => {
      stderr = (stderr + data).slice(-16384);
    });
    const exited = new Promise<void>((resolve) => host.once('exit', () => resolve()));
    let info: { pid: number; helper: number; endpoint: string } | undefined;
    let remote: Browser | undefined;
    const gone = async (pid: number) => {
      try {
        process.kill(pid, 0);
        return undefined;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
        throw error;
      }
    };
    try {
      info = await bounded(
        Promise.race([
          once(host, 'message').then(([message]) => message),
          exited.then(() => {
            throw new Error(`Host exited before ready: ${stderr}`);
          }),
        ]),
        { timeout: 40000 },
      );
      assert.ok(info);
      if (mode !== 'natural') host.kill('SIGKILL');
      await bounded(exited, { timeout: 5000 });
      if (mode === 'owned') {
        await poll(() => gone(info!.pid), { timeout: 10000 }, 'Chrome exit after host death');
      } else {
        remote = await Browser.connect({ endpoint: info.endpoint, attach: 'none' });
        const page = await remote.cdp.send('Target.createTarget', { url: 'about:blank' });
        const session = await remote.attachSession(page.targetId);
        assert.equal(
          (await session.send('Runtime.evaluate', { expression: '6*7' })).result.value,
          42,
        );
      }
    } finally {
      host.kill('SIGKILL');
      await bounded(exited, { timeout: 5000 });
      if (info && !(await gone(info.pid))) {
        remote ??= await Browser.connect({ endpoint: info.endpoint, attach: 'none' });
        await remote.cdp.send('Browser.close').catch(() => {});
        await remote.close();
        await poll(() => gone(info!.pid), { timeout: 10000 });
      }
      if (info) await poll(() => gone(info!.helper), { timeout: 10000 });
      await removeTree(profile);
    }
  });
}
