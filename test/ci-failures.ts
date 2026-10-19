// Prints the failed tests recorded in `node --test` (spec reporter) or `bun test` logs, one per line.
import { readFileSync } from 'node:fs';

const failed = new Set<string>();
for (const file of process.argv.slice(2)) {
  const lines = readFileSync(file, 'utf8')
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split(/\r?\n/);
  // node --test repeats each failure under this heading; earlier ✖ lines include parent suites.
  const summary = lines.indexOf('✖ failing tests:');
  for (const [i, line] of lines.entries())
    if (line.startsWith('(fail) ') || (summary >= 0 && i > summary && line.startsWith('✖ ')))
      failed.add(line);
}
for (const line of failed) console.log(line);
