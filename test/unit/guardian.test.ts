import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Guardian, ReleaseUncertainError } from '../../src/browser/guardian.ts';
import { bounded, poll } from '../../src/utils.ts';

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
