import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseCheckState, type WorkflowRun } from '../release-gate.ts';

const sha = 'release-commit';
const run = (
  file: string,
  id: number,
  status = 'completed',
  conclusion: string | null = 'success',
  event = 'push',
): WorkflowRun => ({
  id,
  path: `.github/workflows/${file}.yml`,
  head_sha: sha,
  event,
  status,
  conclusion,
});
const passed = [run('test', 1), run('platforms', 2, 'completed', 'success', 'workflow_dispatch')];

test('release requires regression and platform checks on the exact commit', () => {
  assert.equal(releaseCheckState([], sha), 'wait');
  assert.equal(releaseCheckState([run('test', 1)], sha), 'wait');
  assert.equal(releaseCheckState(passed, 'another-commit'), 'wait');
  assert.equal(releaseCheckState(passed, sha), 'pass');
});

test('a successful older run does not permit release while a newer required run is unfinished', () => {
  for (const file of ['test', 'platforms']) {
    assert.equal(releaseCheckState([...passed, run(file, 3, 'in_progress', null)], sha), 'wait');
    assert.equal(releaseCheckState([...passed, run(file, 3, 'queued', null)], sha), 'wait');
    assert.equal(releaseCheckState([...passed, run(file, 3, 'waiting', null)], sha), 'wait');
  }
  // Only the newest run counts: a newer success supersedes an older run that is still going.
  const superseded = [run('test', 1, 'in_progress', null), run('platforms', 2), run('test', 3)];
  assert.equal(releaseCheckState(superseded, sha), 'pass');
});

test('the latest failure, cancellation or timeout blocks release; a successful retry can recover', () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    const failed = [...passed, run('platforms', 3, 'completed', conclusion)];
    assert.equal(releaseCheckState(failed, sha), 'fail');
    assert.equal(releaseCheckState([run('platforms', 4), ...failed], sha), 'pass');
  }
  // A failed required workflow is final; the release does not wait for the other one.
  const failing = [
    run('test', 1, 'completed', 'failure'),
    run('platforms', 2, 'in_progress', null),
  ];
  assert.equal(releaseCheckState(failing, sha), 'fail');
});

test('workflows outside the required set never affect the release', () => {
  const states = [
    ['completed', 'failure'],
    ['completed', 'cancelled'],
    ['in_progress', null],
    ['queued', null],
  ] as const;
  for (const file of ['chromium-preview', 'release'])
    for (const event of ['schedule', 'pull_request', 'workflow_dispatch', 'push'])
      for (const [status, conclusion] of states) {
        const other = run(file, 3, status, conclusion, event);
        assert.equal(releaseCheckState([...passed, other], sha), 'pass');
        assert.equal(releaseCheckState([run('test', 1), other], sha), 'wait');
      }
});

test('pull-request runs are not evidence for the release commit', () => {
  const pr = (
    file: string,
    id: number,
    status = 'completed',
    conclusion: string | null = 'success',
  ) => run(file, id, status, conclusion, 'pull_request');
  assert.equal(releaseCheckState([pr('test', 1), pr('platforms', 2)], sha), 'wait');
  assert.equal(releaseCheckState([pr('test', 3), run('platforms', 2)], sha), 'wait');
  assert.equal(releaseCheckState([...passed, pr('test', 3, 'completed', 'failure')], sha), 'pass');
  assert.equal(
    releaseCheckState([...passed, pr('platforms', 3, 'in_progress', null)], sha),
    'pass',
  );
  const failed = [run('test', 1, 'completed', 'failure'), run('platforms', 2), pr('test', 3)];
  assert.equal(releaseCheckState(failed, sha), 'fail');
});

test('release does not confuse a different commit with this release', () => {
  assert.equal(
    releaseCheckState(
      [...passed, { ...run('test', 4, 'in_progress', null), head_sha: 'other' }],
      sha,
    ),
    'pass',
  );
  assert.equal(
    releaseCheckState(
      [...passed, { ...run('test', 4, 'completed', 'failure'), head_sha: 'other' }],
      sha,
    ),
    'pass',
  );
});
