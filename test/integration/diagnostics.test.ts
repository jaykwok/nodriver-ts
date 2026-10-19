import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { Browser } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.ts';
for (const transport of ['pipe', 'websocket'] as const) {
  test(`${transport}: structured diagnostics separate native, explicit, resolver, site and missing observations`, async () => {
    const fixture = await fixtureServer(),
      audit = recordWire(transport),
      browser = await Browser.launch({
        transport,
        headless: process.env.NODRIVER_HEADFUL !== '1',
        args: ['--site-per-process'],
        maskHeadless: false,
      });
    try {
      const tab = await browser.newTab(fixture.base + '/signals');
      const native = await tab.diagnoseEnvironment({
        worker: true,
        webgl: true,
        fontSelectors: ['#latin', '#cjk', '#emoji'],
        httpProbe: fixture.base + '/signals/ip',
        stunServers: [],
        siteAssessments: [
          { site: 'local-test', label: 'fixture label only', observedAt: new Date().toISOString() },
        ],
      });
      expect(native.frames).toHaveLength(4);
      expect(native.fonts.status).toBe('observed');
      expect(native.fonts.value).toHaveLength(12);
      expect(native.http.status).toBe('observed');
      expect(native.webrtc.status).toBe('observed');
      expect(native.webrtc.value!.complete).toBe(true);
      expect(native.overrides.requested).toEqual({});
      expect(native.nativeBaseline).toBeUndefined();
      expect(native.siteAssessments.source).toBe('site-assessment');
      expect(native.routing.webRtcIPHandlingPolicy).toBe('native');
      const ua = native.frames[0]!.document.userAgent,
        language = native.frames[0]!.document.language;
      let calls = 0;
      const aligned = await tab.alignEnvironment(
        {
          environment: {
            viewport: {
              width: 720,
              height: 520,
              deviceScaleFactor: 1,
              screenWidth: 1100,
              screenHeight: 800,
            },
          },
          geoip: { address: 'fixture-only', fields: ['timezone'] },
          inspect: { httpProbe: fixture.base + '/signals/ip' },
        },
        async (address) => {
          calls++;
          expect(address).toBe('fixture-only');
          return {
            timezone: 'Europe/Paris',
            geolocation: { latitude: 1, longitude: 2 },
            label: 'local resolver fixture',
          };
        },
      );
      expect(calls).toBe(1);
      expect(aligned.requested.geolocation).toBeUndefined();
      expect(aligned.requested.userAgent).toBeUndefined();
      expect(aligned.after.frames[0]!.document.userAgent).toBe(ua);
      expect(aligned.after.frames[0]!.document.language).toBe(language);
      expect(aligned.after.frames[0]!.document.timezone).toBe('Europe/Paris');
      expect(aligned.after.frames[0]!.document.screen.width).toBe(1100);
      expect(aligned.after.frames[0]!.document.viewport.width).toBe(720);
      expect(aligned.after.nativeBaseline!.document.userAgent).toBe(ua);
      expect(
        aligned.verification.some(
          (v) => v.field === 'timezone' && v.scope.endsWith('/document') && v.status === 'match',
        ),
      ).toBe(true);
      expect(
        aligned.verification
          .filter((v) => v.field === 'viewport' && v.scope.endsWith('/worker'))
          .every((v) => v.status === 'unavailable'),
      ).toBe(true);
      await expect(
        tab.alignEnvironment({ geoip: { address: 'x', fields: ['timezone'] } }),
      ).rejects.toThrow('caller-supplied resolver');
      const invalid = await tab.diagnoseEnvironment({ httpProbe: fixture.base + '/not-json' });
      expect(invalid.http.status).toBe('unavailable');
      expect(invalid.webrtc.status).toBe('not-requested');
      const explicit = await tab.alignEnvironment({
        environment: { locale: 'fr-FR', acceptLanguage: 'fr-FR,fr', timezone: 'Europe/Berlin' },
        inspect: { httpProbe: fixture.base + '/signals/ip' },
      });
      expect(explicit.after.frames[0]!.document.intlLocale).toBe('fr-FR');
      expect(explicit.after.frames[0]!.document.language).toBe('fr-FR');
      expect(explicit.after.http.value!.headers!['accept-language']).toContain('fr');
      expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
    } finally {
      await browser.close();
      await fixture.server.stop();
      audit.restore();
    }
  });
}
test('explicit WebRTC routing policy is observable and does not become the default', async () => {
  const fixture = await fixtureServer(),
    browser = await Browser.launch({
      headless: true,
      webRtcIPHandlingPolicy: 'disable_non_proxied_udp',
    });
  try {
    const tab = await browser.newTab(fixture.base + '/signals'),
      report = await tab.diagnoseEnvironment({ stunServers: [] });
    expect(report.routing.webRtcIPHandlingPolicy).toBe('disable_non_proxied_udp');
    expect(report.webrtc.value?.complete).toBe(true);
    expect(report.webrtc.value!.candidates.filter((c) => c.protocol === 'udp')).toEqual([]);
  } finally {
    await browser.close();
    await fixture.server.stop();
  }
});
test('geolocation alignment reports permission gaps and verifies only already-granted location', async () => {
  const fixture = await fixtureServer(),
    browser = await Browser.launch({ headless: true });
  try {
    const tab = await browser.newTab(fixture.base + '/mcp');
    const denied = await tab.diagnoseEnvironment({ geolocation: true });
    expect(denied.geolocation.status).toBe('unavailable');
    await tab.context.grantPermissions(['geolocation'], fixture.base);
    const applied = await tab.alignEnvironment({
      environment: { geolocation: { latitude: 1.25, longitude: 2.5, accuracy: 50 } },
      timeout: 5000,
    });
    expect(applied.applicationError).toBeUndefined();
    expect(applied.verification.find((v) => v.field === 'geolocation')!.status).toBe('match');
  } finally {
    await browser.close();
    await fixture.server.stop();
  }
});
