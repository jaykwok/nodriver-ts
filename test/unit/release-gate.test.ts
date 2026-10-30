import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseCheckState, type WorkflowRun } from '../release-gate.ts';

const sha = 'release-commit';
const run = (
  file: string,
  id: number,
  status = 'completed',
  conclusion: string | null = 'success',
): WorkflowRun => ({
  id,
  path: `.github/workflows/${file}.yml`,
  head_sha: sha,
  status,
  conclusion,
});
const passed = [run('test', 1), run('platforms', 2)];

test('release requires regression and platform checks on the exact commit', () => {
  assert.equal(releaseCheckState([], sha), 'wait');
  assert.equal(releaseCheckState([run('test', 1)], sha), 'wait');
  assert.equal(releaseCheckState(passed, 'another-commit'), 'wait');
  assert.equal(releaseCheckState(passed, sha), 'pass');
});

test('a successful older run does not permit release while another check is running', () => {
  for (const file of ['test', 'platforms', 'chromium-preview']) {
    assert.equal(releaseCheckState([...passed, run(file, 3, 'in_progress', null)], sha), 'wait');
    assert.equal(releaseCheckState([...passed, run(file, 3, 'queued', null)], sha), 'wait');
    assert.equal(releaseCheckState([...passed, run(file, 3, 'waiting', null)], sha), 'wait');
  }
});

test('the latest failure, cancellation or timeout blocks release; a successful retry can recover', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    const failed = [...passed, run('platforms', 3, 'completed', conclusion)];
    assert.equal(releaseCheckState(failed, sha), 'fail');
    assert.equal(releaseCheckState([run('platforms', 4), ...failed], sha), 'pass');
  }
  assert.equal(
    releaseCheckState([...passed, run('chromium-preview', 3, 'completed', 'failure')], sha),
    'fail',
  );
});

test('release does not wait on itself or confuse a different commit with this release', () => {
  assert.equal(releaseCheckState([...passed, run('release', 3, 'in_progress', null)], sha), 'pass');
  assert.equal(
    releaseCheckState(
      [...passed, { ...run('test', 4, 'in_progress', null), head_sha: 'other' }],
      sha,
    ),
    'pass',
  );
});
