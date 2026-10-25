import { Browser } from '../../src/index.ts';
const [profile, mode] = process.argv.slice(2);
const browser = await Browser.launch({
  headless: true,
  attach: 'none',
  detached: true,
  supervised: true,
  userDataDir: profile,
});
const info = {
  pid: browser.process!.pid,
  helper: browser.process!.child.pid,
  endpoint: browser.endpoint,
};
if (mode === 'released' || mode === 'natural') await browser.release();
process.send!(info);
if (mode === 'natural') process.disconnect!();
else setInterval(() => {}, 1000);
