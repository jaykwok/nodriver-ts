import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ProxyForwarder } from '../../src/optional/proxy.ts';
import { socks4aFixture } from '../fixtures/socks.ts';

test('a socks4a upstream leaves hostname resolution to the proxy', async () => {
  const web = createServer((req, res) => res.end(`served ${req.headers.host}${req.url}`));
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  const socks = await socks4aFixture((web.address() as AddressInfo).port);
  const forward = await ProxyForwarder.create(`socks4a://user@127.0.0.1:${socks.port}`);
  const proxy = new URL(forward.url);
  // `.invalid` never resolves, so only the proxy can have received the name.
  const host = 'fixture.invalid';
  try {
    const forwarded = await new Promise<string>((resolve, reject) => {
      const req = request(
        { host: proxy.hostname, port: proxy.port, path: `http://${host}/plain`, headers: { host } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => resolve(`${response.statusCode} ${body}`));
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(forwarded).toBe(`200 served ${host}/plain`);

    const tunnelled = await new Promise<string>((resolve, reject) => {
      const req = request({
        host: proxy.hostname,
        port: proxy.port,
        method: 'CONNECT',
        path: `${host}:80`,
      });
      req.on('error', reject);
      req.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          reject(new Error(String(response.statusCode)));
          return;
        }
        let body = '';
        socket.setEncoding('utf8');
        socket.on('error', reject);
        socket.on('data', (chunk: string) => {
          body += chunk;
          if (body.includes('served')) {
            resolve(body);
            socket.destroy();
          }
        });
        socket.write(`GET /tunnel HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      });
      req.end();
    });
    expect(tunnelled).toContain(`served ${host}/tunnel`);
    expect(socks.requests).toEqual([`${host}:80`, `${host}:80`]);
  } finally {
    await forward.close();
    await socks.close();
    await new Promise<void>((r) => web.close(() => r()));
  }
});

test('an unknown upstream scheme is refused before anything listens', async () => {
  await expect(ProxyForwarder.create('ftp://127.0.0.1:21')).rejects.toThrow(
    'Unsupported upstream proxy protocol',
  );
});
