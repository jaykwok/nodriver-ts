import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { WebSocketServer } from 'ws';
import { Connection, DisconnectedError, WebSocketTransport } from '../../src/index.ts';
import { once } from 'node:events';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
test('a failed WebSocket connection keeps the error that caused it', async () => {
  const server = createServer();
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  const error = await WebSocketTransport.connect(`ws://127.0.0.1:${port}`).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DisconnectedError);
  expect((error as Error).cause).toBeInstanceOf(Error);
  expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('ECONNREFUSED');
});
test('WebSocket reassembles fragmented Unicode text and enforces payload size', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      const request = JSON.parse(data.toString());
      const bytes = Buffer.from(
        JSON.stringify({ id: request.id, result: { product: '中文 😀'.repeat(50) } }),
      );
      socket.send(bytes.subarray(0, 45), { binary: false, fin: false });
      socket.send(bytes.subarray(45), { binary: false, fin: true });
    });
  });
  try {
    const transport = await WebSocketTransport.connect(`ws://127.0.0.1:${port}`);
    const connection = new Connection(transport);
    expect((await connection.root.send('Browser.getVersion')).product).toBe('中文 😀'.repeat(50));
    await connection.close();
    const small = new Connection(
      await WebSocketTransport.connect(`ws://127.0.0.1:${port}`, { maxMessageBytes: 30 }),
    );
    await expect(small.root.send('Browser.getVersion')).rejects.toThrow();
    expect(small.pendingCount).toBe(0);
    await small.close();
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
