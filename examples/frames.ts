import { Browser } from '../src/index.ts';
import { fixtureServer } from '../test/fixtures/server.ts';
const fixture = await fixtureServer();
try {
  await using browser = await Browser.launch({ args: ['--site-per-process'] });
  const tab = await browser.newTab(fixture.base + '/page?frames=1');
  for (const frame of tab.frames) {
    console.log(frame.url, frame.session.id);
    const button = await frame.query('button');
    if (button) {
      await button.click();
      console.log(await button.text());
    }
  }
} finally {
  await fixture.server.stop();
}
