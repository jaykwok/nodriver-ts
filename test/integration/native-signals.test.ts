import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { appendFile } from 'node:fs/promises';
import { Browser } from '../../src/index.ts';
import { fixtureServer } from '../fixtures/server.ts';
import { recordWire, forbiddenAutomaticCommands } from '../fixtures/wire.ts';

for (const transport of ['pipe', 'websocket'] as const) {
  test(`${transport}: actual platform fonts and HTTP peer address across four frames`, async () => {
    const fixture = await fixtureServer(),
      audit = recordWire(transport);
    const browser = await Browser.launch({
      transport,
      args: ['--site-per-process'],
      headless: process.env.NODRIVER_HEADFUL !== '1',
    });
    try {
      const tab = await browser.newTab(fixture.base + '/signals');
      expect(tab.frames).toHaveLength(4);
      const samples = [];
      for (const frame of tab.frames) {
        const surface = await frame.evaluate(
          async () => {
            await document.fonts.ready;
            const response = await fetch('/signals/ip');
            return {
              fontsStatus: document.fonts.status,
              peer: (await response.json()) as { ip: string },
              text: [...document.querySelectorAll('p')].map((p) => ({
                id: p.id,
                text: p.textContent,
                width: (() => {
                  const range = document.createRange();
                  range.selectNodeContents(p);
                  return range.getBoundingClientRect().width;
                })(),
                cssFamily: getComputedStyle(p).fontFamily,
              })),
            };
          },
          undefined,
          { world: 'isolated' },
        );
        expect(surface.fontsStatus).toBe('loaded');
        expect(surface.peer.ip).toMatch(/(?:127\.0\.0\.1|::1)$/);
        await frame.session.send('DOM.enable');
        await frame.session.send('CSS.enable');
        await frame.session.send('DOM.getDocument', { depth: 0 });
        const fonts = [];
        for (const id of ['latin', 'cjk', 'emoji']) {
          const element = await frame.waitForSelector('#' + id);
          const { nodeIds } = await frame.session.send('DOM.pushNodesByBackendIdsToFrontend', {
            backendNodeIds: [element.backendNodeId],
          });
          const actual = await frame.session.send('CSS.getPlatformFontsForNode', {
            nodeId: nodeIds[0]!,
          });
          expect(actual.fonts.length).toBeGreaterThan(0);
          expect(actual.fonts.every((f) => f.familyName.length > 0 && f.glyphCount > 0)).toBe(true);
          expect(surface.text.find((p) => p.id === id)!.width).toBeGreaterThan(0);
          fonts.push({ id, fonts: actual.fonts });
        }
        samples.push({ frameId: frame.id, url: frame.url, ...surface, fonts });
      }
      expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
      if (process.env.NODRIVER_SIGNALS_REPORT)
        await appendFile(
          process.env.NODRIVER_SIGNALS_REPORT,
          JSON.stringify({
            date: new Date().toISOString(),
            platform: process.platform,
            transport,
            browser: browser.version.product,
            samples,
          }) + '\n',
        );
    } finally {
      await browser.close();
      await fixture.server.stop();
      audit.restore();
    }
  });

  test(`${transport}: native WebRTC local data channel transfers Unicode and closes peers`, async () => {
    const fixture = await fixtureServer(),
      audit = recordWire(transport);
    const browser = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      transport,
      // Hosts that cannot resolve mDNS candidates: --disable-features=WebRtcHideLocalIpsWithMdns.
      args: process.env.NODRIVER_WEBRTC_ARGS?.split(' ').filter(Boolean),
    });
    try {
      const tab = await browser.newTab(fixture.base + '/signals');
      const report = await tab.evaluate(
        async () => {
          const a = new RTCPeerConnection({ iceServers: [] }),
            b = new RTCPeerConnection({ iceServers: [] });
          const channel = a.createDataChannel('native-signals');
          const candidates: {
            type: string | null;
            protocol: string | null;
            address: string | null;
          }[] = [];
          const toA: RTCIceCandidateInit[] = [],
            toB: RTCIceCandidateInit[] = [];
          let readyA = false,
            readyB = false,
            timer: ReturnType<typeof setTimeout> | undefined;
          let received = '';
          const done = new Promise<void>((resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `Local WebRTC data channel timed out: ${JSON.stringify({
                      ice: [a.iceConnectionState, b.iceConnectionState],
                      gathering: [a.iceGatheringState, b.iceGatheringState],
                      candidates,
                    })}`,
                  ),
                ),
              10000,
            );
            a.onicecandidate = (e) => {
              if (!e.candidate) return;
              candidates.push({
                type: e.candidate.type,
                protocol: e.candidate.protocol,
                address: e.candidate.address,
              });
              if (readyB) void b.addIceCandidate(e.candidate).catch(reject);
              else toB.push(e.candidate.toJSON());
            };
            b.onicecandidate = (e) => {
              if (!e.candidate) return;
              if (readyA) void a.addIceCandidate(e.candidate).catch(reject);
              else toA.push(e.candidate.toJSON());
            };
            b.ondatachannel = (e) => {
              e.channel.onmessage = (message) => e.channel.send('ack:' + String(message.data));
            };
            channel.onopen = () => channel.send('原生 WebRTC 中文😀');
            channel.onmessage = (e) => {
              received = String(e.data);
              resolve();
            };
            channel.onerror = () => reject(new Error('Local WebRTC channel error'));
          });
          // Attach a rejection observer before awaiting SDP work.
          void done.catch(() => {});
          try {
            await a.setLocalDescription(await a.createOffer());
            await b.setRemoteDescription(a.localDescription!);
            readyB = true;
            for (const c of toB) await b.addIceCandidate(c);
            await b.setLocalDescription(await b.createAnswer());
            await a.setRemoteDescription(b.localDescription!);
            readyA = true;
            for (const c of toA) await a.addIceCandidate(c);
            await done;
          } finally {
            clearTimeout(timer);
            await new Promise<void>((resolve, reject) => {
              const deadline = setTimeout(
                () => reject(new Error('WebRTC channel did not close')),
                2000,
              );
              const finish = () => {
                clearTimeout(deadline);
                resolve();
              };
              channel.addEventListener('close', finish, { once: true });
              channel.close();
              a.close();
              b.close();
              if (channel.readyState === 'closed') finish();
            });
          }
          return {
            received,
            candidates,
            states: [a.connectionState, b.connectionState],
            channelState: channel.readyState,
          };
        },
        undefined,
        { world: 'isolated', timeout: 15000 },
      );
      expect(report.received).toBe('ack:原生 WebRTC 中文😀');
      expect(report.candidates.some((c) => c.type === 'host')).toBe(true);
      expect(report.states).toEqual(['closed', 'closed']);
      expect(report.channelState).toBe('closed');
      expect(audit.messages.filter((m) => forbiddenAutomaticCommands.includes(m.method))).toEqual(
        [],
      );
      if (process.env.NODRIVER_SIGNALS_REPORT)
        await appendFile(
          process.env.NODRIVER_SIGNALS_REPORT,
          JSON.stringify({
            date: new Date().toISOString(),
            platform: process.platform,
            transport,
            browser: browser.version.product,
            webrtc: report,
          }) + '\n',
        );
    } finally {
      await browser.close();
      await fixture.server.stop();
      audit.restore();
    }
  });
}
