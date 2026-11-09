import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Browser } from '../../src/index.ts';
import {
  workerEnvironmentFixture,
  workerContexts,
} from '../../benchmarks/worker-environment-fixture.ts';

test(
  'Linux native defaults agree in initial documents and Dedicated/Shared/Service Workers',
  {
    skip: process.platform !== 'linux' || !process.env.CI,
  },
  async () => {
    const fixture = await workerEnvironmentFixture();
    try {
      await using browser = await Browser.launch({
        headless: true,
        maskHeadless: false,
        nativeEnvironment: { timezone: 'Europe/Paris', locale: 'fr-FR' },
      });
      const run = 'native-launch';
      await browser.newTab(`${fixture.origin}/r/${run}/page?run=${run}&kind=document`);
      await fixture.wait(run);
      const samples = fixture.samples.filter((s) => s.run === run);
      const document = samples.find((s) => s.kind === 'document');
      assert.ok(document, 'document');
      for (const kind of workerContexts) {
        const sample = samples.find((s) => s.kind === kind);
        assert.ok(sample, kind);
        assert.equal(sample.initial.timezone, 'Europe/Paris', kind);
        // Chrome resolves the default Intl locale to a UI language it ships, which can be fr.
        assert.equal(new Intl.Locale(sample.initial.locale).language, 'fr', kind);
        assert.equal(sample.initial.locale, document.initial.locale, kind);
        assert.equal(sample.initial.language, 'fr-FR', kind);
        assert.deepEqual(sample.initial.languages, document.initial.languages, kind);
        const request = fixture.requests.find(
          (r) => r.run === run && r.kind === kind && r.path === '/sample',
        );
        assert.ok(request, `request from ${kind}`);
        assert.equal(request.headers['accept-language']?.split(',')[0], 'fr-FR', kind);
      }
    } finally {
      await fixture.close();
    }
  },
);
