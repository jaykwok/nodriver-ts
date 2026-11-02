import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { poll, removeTree } from '../../src/utils.ts';

interface Owned {
  pid: number;
  profile: string;
}
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function host(mode: 'default' | 'hosted' | 'exit') {
  const directory = await mkdtemp(join(tmpdir(), 'nodriver-signals-'));
  const record = join(directory, 'record.json');
  const child = spawn(
    process.execPath,
    [join(import.meta.dirname, '../fixtures/signal-host.ts'), record, mode],
    { stdio: 'ignore', windowsHide: true },
  );
  const exited = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;
  const owned = await poll(
    async () =>
      readFile(record, 'utf8').then(
        (text) => JSON.parse(text) as Owned[],
        () => undefined,
      ),
    { timeout: 60_000 },
    'host launch record',
  );
  const gone = () =>
    poll(async () => owned.every(({ pid }) => !running(pid)) || undefined, { timeout: 15_000 });
  const cleanup = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const { pid } of owned) if (running(pid)) process.kill(pid, 'SIGKILL');
    for (const { profile } of owned) await removeTree(profile);
    await removeTree(directory);
  };
  return { child, exited, owned, record, gone, cleanup };
}

test('the host exit ends Chrome launched without detached', async () => {
  const { exited, gone, cleanup } = await host('exit');
  try {
    assert.deepEqual(await exited, [0, null]);
    await gone();
  } finally {
    await cleanup();
  }
});

test(
  'SIGTERM closes every handled browser before the host terminates',
  { skip: process.platform === 'win32' && 'Windows cannot deliver a catchable SIGTERM' },
  async () => {
    const { child, exited, owned, gone, cleanup } = await host('default');
    try {
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [null, 'SIGTERM']);
      await gone();
      // Both temporary profiles were removed before the host was terminated.
      for (const { profile } of owned) await assert.rejects(access(profile), { code: 'ENOENT' });
    } finally {
      await cleanup();
    }
  },
);

test(
  'SIGTERM closes Chrome but leaves the host running when the host handles the signal',
  { skip: process.platform === 'win32' && 'Windows cannot deliver a catchable SIGTERM' },
  async () => {
    const { child, record, gone, cleanup } = await host('hosted');
    try {
      child.kill('SIGTERM');
      await gone();
      await poll(
        async () =>
          access(record + '.hosted').then(
            () => true,
            () => undefined,
          ),
        {
          timeout: 5_000,
        },
      );
      // Re-raising the signal would have terminated the host by now.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    } finally {
      await cleanup();
    }
  },
);
