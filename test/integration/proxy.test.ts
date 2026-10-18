import { describe, expect, test } from 'bun:test';
import { Server } from 'proxy-chain';
import { createServer } from 'node:net';
import { request } from 'node:http';
import { Browser, ProxyForwarder } from '../../src/index.js';
import { fixtureServer } from '../fixtures/server.js';
import { socksFixture } from '../fixtures/socks.js';
describe('proxy routing', () => {
  test('authenticated HTTP upstream, context-specific egress, and CONNECT tunnel', async () => {
    const fixture = fixtureServer();
    let authenticated = 0;
    const urls: string[] = [];
    const upstream = new Server({
      host: '127.0.0.1',
      port: 0,
      prepareRequestFunction: ({ username, password, request }) => {
        urls.push(request.url ?? '');
        if (username !== 'user' || password !== 'pass') return { requestAuthentication: true };
        authenticated++;
        return { requestAuthentication: false };
      },
    });
    await upstream.listen();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 15_000,
    });
    try {
      const context = await b.newContext({
        proxy: `http://user:pass@127.0.0.1:${upstream.port}`,
        proxyBypassList: '<-loopback>',
      });
      const tab = await context.newTab(fixture.base + '/page');
      expect(await tab.evaluate('secret')).toBe('main-secret');
      expect(authenticated).toBeGreaterThan(0);
      const direct = await b.newContext();
      await direct.newTab(fixture.base + '/empty?direct=1');
      expect(urls.some((url) => url.includes('/empty?direct=1'))).toBeFalse();
      await direct.close();
      await context.close();
      const echo = createServer((socket) => socket.pipe(socket));
      await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
      const forward = await ProxyForwarder.create(`http://user:pass@127.0.0.1:${upstream.port}`);
      try {
        const proxy = new URL(forward.url);
        const port = (echo.address() as { port: number }).port;
        const text = await new Promise<string>((resolve, reject) => {
          const req = request({
            host: proxy.hostname,
            port: Number(proxy.port),
            method: 'CONNECT',
            path: `127.0.0.1:${port}`,
          });
          req.on('error', reject);
          req.on('connect', (response, socket) => {
            if (response.statusCode !== 200) {
              socket.destroy();
              reject(Error(String(response.statusCode)));
              return;
            }
            socket.once('data', (b) => {
              resolve(b.toString());
              socket.destroy();
            });
            socket.on('error', reject);
            socket.write('tunnel 中文');
          });
          req.end();
        });
        expect(text).toBe('tunnel 中文');
      } finally {
        await forward.close();
        await new Promise<void>((r) => echo.close(() => r()));
      }
    } finally {
      await b.close();
      await upstream.close(true);
      fixture.server.stop(true);
    }
  });
  test('SOCKS5 username/password and fragmented handshake', async () => {
    const fixture = fixtureServer();
    const socks = await socksFixture();
    const b = await Browser.launch({
      headless: process.env.NODRIVER_HEADFUL !== '1',
      timeout: 15_000,
    });
    try {
      const context = await b.newContext({
        proxy: `socks5://user:pass@127.0.0.1:${socks.port}`,
        proxyBypassList: '<-loopback>',
      });
      const tab = await context.newTab(fixture.base + '/page');
      expect(await tab.evaluate('secret')).toBe('main-secret');
      expect(socks.authenticated).toBeGreaterThan(0);
      expect(socks.requests.some((r) => r === `127.0.0.1:${fixture.server.port}`)).toBeTrue();
      await context.close();
    } finally {
      await b.close();
      await socks.close();
      fixture.server.stop(true);
    }
  });
});
