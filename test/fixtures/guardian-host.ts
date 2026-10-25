import { Guardian } from '../../src/browser/guardian.ts';
import { readFile } from 'node:fs/promises';
import { poll } from '../../src/utils.ts';

const [record, mode] = process.argv.slice(2);
// Both descendants stay alive and keep writing stderr across the ownership transition.
const descendant = "setInterval(() => process.stderr.write('child-noise'), 10)";
const script = `
  const {spawn} = require('node:child_process');
  const fs = require('node:fs');
  process.on('exit', code => fs.appendFileSync(${JSON.stringify(record + '.error')}, 'exit:' + code));
  const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio: ['ignore','ignore','inherit']});
  child.on('exit', (code, signal) => fs.appendFileSync(${JSON.stringify(record + '.error')}, 'child-exit:' + code + ':' + signal));
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid:process.pid, descendant:child.pid}));
  setInterval(() => process.stderr.write('root-noise'), 10);
`;
const guardian = await Guardian.create(process.execPath, ['-e', script], process.env);
await guardian.waitReady({ timeout: 15000 });
const info = await poll(async () => readFile(record!, 'utf8').then(JSON.parse, () => undefined), {
  timeout: 5000,
});
if (mode === 'released' || mode === 'natural') await guardian.release();
process.send!({ ...info, helper: guardian.child.pid });
if (mode === 'natural') process.disconnect!();
else setInterval(() => {}, 1000);
