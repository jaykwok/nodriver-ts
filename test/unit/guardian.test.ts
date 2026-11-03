import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { mkdir, mkdtemp, readdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  Guardian,
  ReleaseUncertainError,
  sweepHelperDirectories,
} from '../../src/browser/guardian.ts';
import { bounded, poll, removeTree } from '../../src/utils.ts';

test('guardian captures bounded UTF-8 stderr, preserves arguments/env and confirms owned cleanup', async () => {
  const marker = '尾部-"quoted"-\\-🙂';
  const script = `process.stderr.write('x'.repeat(100000) + process.argv[1] + process.env.NODRIVER_GUARDIAN_TEST); setInterval(() => {}, 1000);`;
  const guardian = await Guardian.create(process.execPath, ['-e', script, marker], {
    ...process.env,
    NODRIVER_GUARDIAN_TEST: '-env-end',
  });
  try {
    await guardian.waitReady({ timeout: 15000 });
    await poll(
      async () => {
        await guardian.snapshot();
        return guardian.diagnostics.stderr.endsWith(marker + '-env-end') || undefined;
      },
      { timeout: 5000 },
    );
    assert.ok(Buffer.byteLength(guardian.diagnostics.stderr) <= 16384);
    assert.ok(guardian.diagnostics.pid! > 0);
    assert.equal(guardian.diagnostics.stderrStatus, 'captured');
    await guardian.close();
    assert.equal(guardian.diagnostics.exited, true);
  } finally {
    await guardian.close();
  }
});

test('guardian release disconnects host streams while browser stderr continues without a host dependency', async () => {
  const guardian = await Guardian.create(
    process.execPath,
    ['-e', "setInterval(() => process.stderr.write('x'.repeat(32768)), 5)"],
    process.env,
  );
  let released = false;
  try {
    await guardian.waitReady({ timeout: 15000 });
    await guardian.release();
    released = true;
    assert.ok(guardian.child.stdin?.destroyed);
    assert.ok(guardian.child.stdout?.destroyed);
    await new Promise((resolve) => setTimeout(resolve, 200));
    process.kill(guardian.diagnostics.pid!, 0);
  } finally {
    if (released) {
      process.kill(guardian.diagnostics.pid!, 'SIGKILL');
      await bounded(guardian.stopped, { timeout: 5000 });
    } else await guardian.close();
  }
});

test('EOF during helper startup leaves no owned child and close is idempotent', async () => {
  const guardian = await Guardian.create(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    process.env,
  );
  await Promise.all([guardian.close(), guardian.close()]);
  assert.ok(guardian.diagnostics.pid === undefined || guardian.diagnostics.exited);
});

test('invalid executable fails closed without claiming a running PID', async () => {
  const guardian = await Guardian.create('/nodriver-missing-guardian-executable', [], process.env);
  try {
    await assert.rejects(guardian.waitReady({ timeout: 15000 }));
    assert.equal(guardian.diagnostics.pid, undefined);
  } finally {
    await guardian.close();
  }
});

test('lost release acknowledgement is explicit and never kills a potentially released child', async () => {
  const guardian = await Guardian.create(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    process.env,
  );
  try {
    await guardian.waitReady({ timeout: 15000 });
    // Simulate a lost acknowledgement while the command itself still reaches the helper.
    guardian.child.stdout!.pause();
    await assert.rejects(guardian.release(), ReleaseUncertainError);
    process.kill(guardian.diagnostics.pid!, 0);
  } finally {
    try {
      process.kill(guardian.diagnostics.pid!, 'SIGKILL');
    } catch {}
    await bounded(guardian.stopped, { timeout: 5000 });
  }
});

test('cancelled guardian creation preserves the original reason before browser spawn', async () => {
  const reason = new Error('cancel before compile');
  await assert.rejects(
    Guardian.create(process.execPath, [], process.env, { signal: AbortSignal.abort(reason) }),
    (error) => error === reason,
  );
});

test('a release after the browser exited is refused, not uncertain, and close still confirms exit', async () => {
  const guardian = await Guardian.create(process.execPath, ['-e', 'process.exit(0)'], process.env);
  try {
    await guardian.waitReady({ timeout: 15000 });
    await poll(async () => guardian.diagnostics.exited || undefined, { timeout: 5000 });
    await assert.rejects(guardian.release(), (error) => !(error instanceof ReleaseUncertainError));
  } finally {
    await guardian.close();
  }
  assert.equal(guardian.diagnostics.exited, true);
});

/** A helper process that answers only through `script`, which sees each command it receives. */
function scriptedHelper(script: (command: { command: string; id?: number }) => string[] | 'die') {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const stdout = new PassThrough();
  const close = () => {
    stdout.end();
    stdout.once('end', () => setImmediate(() => child.emit('close', 0)));
    stdout.resume();
  };
  let config = true;
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        if (config) {
          config = false;
          stdout.write(JSON.stringify({ type: 'started', pid: 1 }) + '\n');
          continue;
        }
        const reply = script(JSON.parse(line));
        if (reply === 'die') close();
        else for (const message of reply) stdout.write(message + '\n');
      }
      done();
    },
  });
  Object.assign(child, { stdin, stdout, stderr: new PassThrough(), unref() {} });
  return new (Guardian as unknown as new (...args: unknown[]) => Guardian)(child, 'chrome', [], {});
}

test('a release that the browser exit overtakes is refused; a helper lost mid-release is uncertain', async () => {
  // The Windows helper stops reading commands once Chrome exits, then reports the exit and ends.
  const overtaken = scriptedHelper(() => [JSON.stringify({ type: 'exited', exitCode: 0 })]);
  await overtaken.waitReady({ timeout: 1000 });
  const release = overtaken.release();
  await poll(async () => overtaken.diagnostics.exited || undefined, { timeout: 1000 });
  (overtaken as unknown as { child: EventEmitter }).child.emit('close', 0);
  await assert.rejects(release, (error) => !(error instanceof ReleaseUncertainError));

  const lost = scriptedHelper(() => 'die');
  await lost.waitReady({ timeout: 1000 });
  await assert.rejects(lost.release(), ReleaseUncertainError);
});

test('the sweep removes only stale helper directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'nodriver-sweep-'));
  try {
    const now = Date.now();
    const old = new Date(now - 2 * 60 * 60 * 1000);
    const entry = async (name: string, files: string[], stale: boolean) => {
      await mkdir(join(root, name));
      for (const file of files) await writeFile(join(root, name, file), '');
      if (stale) await utimes(join(root, name), old, old);
    };
    await entry('nodriver-guardian-exited', ['guardian.exe'], true);
    await entry('nodriver-guardian-failed', [], true);
    // A launch may still be compiling into a recent directory.
    await entry('nodriver-guardian-recent', ['guardian.exe'], false);
    await entry('nodriver-other', ['guardian.exe'], true);
    await writeFile(join(root, 'nodriver-guardian-file'), '');
    await utimes(join(root, 'nodriver-guardian-file'), old, old);
    await sweepHelperDirectories(root, now);
    assert.deepEqual((await readdir(root)).sort(), [
      'nodriver-guardian-file',
      'nodriver-guardian-recent',
      'nodriver-other',
    ]);
    // A missing root is not an error.
    await sweepHelperDirectories(join(root, 'missing'), now);
  } finally {
    await removeTree(root);
  }
});
