import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { bounded, poll, removeTree } from '../../src/utils.ts';

async function running(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      return !['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!);
    }
    return true;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code!)) return false;
    throw error;
  }
}
for (const mode of [
  'owned',
  'released',
  'natural',
  ...(process.platform === 'win32' ? ['helper-death'] : []),
]) {
  test(`guardian ${mode}: hard exit preserves the correct root and descendant ownership`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nodriver-guardian-'));
    const record = join(dir, 'pids.json');
    const host = fork(
      fileURLToPath(new URL('../fixtures/guardian-host.ts', import.meta.url)),
      [record, mode],
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
    let info: { pid: number; descendant: number; helper: number } | undefined;
    try {
      const first = await bounded(
        Promise.race([
          once(host, 'message').then(([message]) => message),
          exited.then(() => {
            throw new Error(`Host exited before ready: ${stderr}`);
          }),
        ]),
        { timeout: 20000 },
      );
      info = first as typeof info;
      assert.ok(info);
      if (mode === 'helper-death') process.kill(info.helper, 'SIGKILL');
      else if (mode !== 'natural') host.kill('SIGKILL');
      if (mode !== 'helper-death') await bounded(exited, { timeout: 5000 });
      if (mode === 'owned' || mode === 'helper-death') {
        await poll(
          async () =>
            (!(await running(info!.pid)) && !(await running(info!.descendant))) || undefined,
          { timeout: 10000 },
          'owned process tree exit',
        );
      } else {
        await new Promise((resolve) => setTimeout(resolve, 250));
        assert.equal(
          await running(info.pid),
          true,
          `helper alive=${await running(info.helper)}; ${await readFile(record + '.error', 'utf8').catch(() => '')}`,
        );
        assert.equal(
          await running(info.descendant),
          true,
          await readFile(record + '.error', 'utf8').catch(() => 'no exit evidence'),
        );
      }
    } finally {
      host.kill('SIGKILL');
      await bounded(exited, { timeout: 5000 });
      info ??= await readFile(record, 'utf8').then(JSON.parse, () => undefined);
      if (info) {
        for (const pid of [info.descendant, info.pid]) {
          if (await running(pid)) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {}
          }
        }
        if (info.helper)
          await poll(async () => !(await running(info!.helper)) || undefined, { timeout: 5000 });
      }
      await removeTree(dir);
    }
  });
}
