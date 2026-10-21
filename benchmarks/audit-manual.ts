// The collector never creates a browser, opens CDP, or generates input.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { auditFixture } from './audit-fixture.ts';

const fixture = await auditFixture();
const run = 'physical-manual';
const output = resolve('test-results/audit-manual.json');
console.log(
  `Use an empty disposable Chrome profile without debugging flags. Open ${fixture.origin}/r/${run}/page?run=${run}`,
);
console.log(
  'Use a physical keyboard/mouse to type, click and scroll. Record samples with the page button; reload once to observe its own existing Service Worker. Attest only if physical input was used, then click Finish manual collection. No physical sample has been collected by starting this command.',
);
try {
  while (!fixture.reports.some((r) => r.phase === 'manual-finish')) await sleep(500);
  await fixture.sample(run, 'cleanup');
  await mkdir(resolve('test-results'), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        date: new Date().toISOString(),
        physicalInput: fixture.reports.find((r) => r.phase === 'manual-finish')?.physicalInput,
        limitations:
          'User attestation, not independent proof of physical input; record browser version, OS/display/focus and command-line flags alongside this file. Collector created no browser or CDP connection. User must close Chrome and remove only the disposable profile they created.',
        reports: fixture.reports,
        requests: fixture.headers,
      },
      null,
      2,
    ),
  );
  console.log(output);
} finally {
  await fixture.close();
}
