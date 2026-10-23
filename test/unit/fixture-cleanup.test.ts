import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

test('advanced integration fixtures close their servers when Chrome fails before test setup', async () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Run a standalone test runner, not an inherited child channel.
  let failure: (Error & { code?: number | string; killed?: boolean; stdout?: string }) | undefined;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        new URL('../fixtures/fail-browser-launch.ts', import.meta.url).href,
        '--test',
        '--test-reporter=tap',
        fileURLToPath(new URL('../integration/advanced.test.ts', import.meta.url)),
      ],
      { timeout: 10_000, windowsHide: true, env },
    );
  } catch (error) {
    failure = error as typeof failure;
  }
  assert.ok(failure, 'Injected startup failure must fail the child tests');
  assert.equal(failure.killed, false, 'Leaked server must not keep the child alive until timeout');
  assert.equal(failure.code, 1);
  assert.match(failure.stdout ?? '', /Injected browser startup failure/);
  assert.match(failure.stdout ?? '', /# fail 2/);
});
