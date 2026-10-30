import { readFileSync } from 'node:fs';

export interface WorkflowRun {
  id: number;
  head_sha: string;
  path: string;
  status: string;
  conclusion: string | null;
}

const required = ['.github/workflows/test.yml', '.github/workflows/platforms.yml'];
const publishing = '.github/workflows/release.yml';

/** All runs must finish; the newest run of each workflow must succeed on the release commit. */
export function releaseCheckState(runs: WorkflowRun[], sha: string): 'pass' | 'wait' | 'fail' {
  const checks = runs.filter((run) => run.head_sha === sha && run.path !== publishing);
  if (checks.some((run) => run.status !== 'completed')) return 'wait';
  const latest = new Map<string, WorkflowRun>();
  for (const run of checks) {
    if (!latest.has(run.path) || latest.get(run.path)!.id < run.id) latest.set(run.path, run);
  }
  if ([...latest.values()].some((run) => run.conclusion !== 'success')) return 'fail';
  if (required.some((path) => !latest.has(path))) return 'wait';
  return 'pass';
}

if (import.meta.main) {
  const [sha, file] = process.argv.slice(2);
  if (!sha || !file)
    throw new Error('Usage: node test/release-gate.ts <commit> <workflow-runs.json>');
  const pages = JSON.parse(readFileSync(file, 'utf8')) as Array<{ workflow_runs: WorkflowRun[] }>;
  const runs = pages.flatMap((page) => page.workflow_runs);
  for (const run of runs.filter((run) => run.head_sha === sha && run.path !== publishing)) {
    console.error(`${run.path} #${run.id}: ${run.status} / ${run.conclusion ?? 'pending'}`);
  }
  console.log(releaseCheckState(runs, sha));
}
