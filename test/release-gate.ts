import { readFileSync } from 'node:fs';

export interface WorkflowRun {
  id: number;
  head_sha: string;
  path: string;
  /** The triggering event, such as push, workflow_dispatch or pull_request. */
  event: string;
  status: string;
  conclusion: string | null;
}

/** The workflows a release depends on. No other workflow, such as the Chromium preview, counts. */
export const requiredWorkflows = ['.github/workflows/test.yml', '.github/workflows/platforms.yml'];

/** A pull_request run tests the merge of its branch into the base, not the release commit. */
const counts = (run: WorkflowRun, sha: string) =>
  run.head_sha === sha && run.event !== 'pull_request' && requiredWorkflows.includes(run.path);

/**
 * The newest counted run of each required workflow decides: the release fails as soon as one of
 * them finished without success, and waits while one is missing or unfinished.
 */
export function releaseCheckState(runs: WorkflowRun[], sha: string): 'pass' | 'wait' | 'fail' {
  const latest = new Map<string, WorkflowRun>();
  for (const run of runs) {
    if (!counts(run, sha)) continue;
    const newest = latest.get(run.path);
    if (!newest || newest.id < run.id) latest.set(run.path, run);
  }
  const newest = requiredWorkflows.map((path) => latest.get(path));
  if (newest.some((run) => run?.status === 'completed' && run.conclusion !== 'success'))
    return 'fail';
  if (newest.some((run) => run?.status !== 'completed')) return 'wait';
  return 'pass';
}

if (import.meta.main) {
  const [sha, file] = process.argv.slice(2);
  if (!sha || !file)
    throw new Error('Usage: node test/release-gate.ts <commit> <workflow-runs.json>');
  const pages = JSON.parse(readFileSync(file, 'utf8')) as Array<{ workflow_runs: WorkflowRun[] }>;
  const runs = pages.flatMap((page) => page.workflow_runs);
  const required = runs.filter((run) => requiredWorkflows.includes(run.path));
  for (const run of required.filter((run) => run.head_sha === sha))
    console.error(
      `${run.path} #${run.id} (${run.event}): ${run.status} / ${run.conclusion ?? 'pending'}` +
        (counts(run, sha) ? '' : ' - not counted'),
    );
  console.log(releaseCheckState(runs, sha));
}
