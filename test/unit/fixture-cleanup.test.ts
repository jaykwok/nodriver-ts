import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

/**
 * Runs a test file with browser setup failing. A server it leaks keeps the child alive
 * until the timeout. Returns the TAP output.
 */
async function withFailedSetup(
  file: string,
  preload = 'fail-browser-launch.ts',
  message = 'Injected browser startup failure',
): Promise<string> {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // Run a standalone test runner, not an inherited child channel.
  let failure: (Error & { code?: number | string; killed?: boolean; stdout?: string }) | undefined;
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        new URL(`../fixtures/${preload}`, import.meta.url).href,
        '--test',
        '--test-reporter=tap',
        fileURLToPath(new URL(`../${file}`, import.meta.url)),
      ],
      { timeout: 10_000, windowsHide: true, env },
    );
  } catch (error) {
    failure = error as typeof failure;
  }
  assert.ok(failure, 'Injected startup failure must fail the child tests');
  assert.equal(failure.killed, false, 'Leaked server must not keep the child alive until timeout');
  assert.equal(failure.code, 1);
  assert.ok((failure.stdout ?? '').includes(message));
  return failure.stdout ?? '';
}
/** Asserts that every test of the file ran and reached the injected startup failure. */
function allFailed(output: string): void {
  const tests = Number(/^# tests (\d+)$/m.exec(output)?.[1]);
  const failed = Number(/^# fail (\d+)$/m.exec(output)?.[1]);
  const skipped = Number(/^# skipped (\d+)$/m.exec(output)?.[1] ?? 0);
  assert.ok(tests > 0, 'The child must run the tests');
  assert.ok(failed > 0, 'The child must attempt browser startup');
  assert.equal(
    failed + skipped,
    tests,
    'Every enabled child test must reach the injected startup failure',
  );
}

test('advanced integration fixtures close their servers when Chrome fails before test setup', async () => {
  assert.match(await withFailedSetup('integration/advanced.test.ts'), /# fail 2/);
});

test('the site data fixture closes its servers when Chrome fails to start', async () => {
  allFailed(await withFailedSetup('integration/site-data.test.ts'));
});

test('the input behavior fixtures close their servers when Chrome fails to start', async () => {
  allFailed(await withFailedSetup('integration/behavior.test.ts'));
});

test('the network fixtures close their scripted servers when connecting fails', async () => {
  await withFailedSetup(
    'unit/network.test.ts',
    'fail-scripted-connect.ts',
    'Injected scripted connection failure',
  );
});
