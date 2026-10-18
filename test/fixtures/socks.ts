import { createServer, connect, type Socket } from 'node:net';
/** Local authenticated SOCKS5 fixture deliberately fragments every server handshake. */
export async function socksFixture() {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let authenticated = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let state: 'greeting' | 'auth' | 'connect' | 'tunnel' = 'greeting';
    const fragmented = (bytes: Buffer) => {
      socket.write(bytes.subarray(0, 1));
      setTimeout(() => {
        if (!socket.destroyed) socket.write(bytes.subarray(1));
      }, 2);
    };
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (state === 'greeting') {
        if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
        buffer = buffer.subarray(2 + buffer[1]!);
        state = 'auth';
        fragmented(Buffer.from([5, 2]));
      }
      if (state === 'auth') {
        if (buffer.length < 2 || buffer.length < 3 + buffer[1]!) return;
        const ulen = buffer[1]!,
          plen = buffer[2 + ulen]!;
        if (buffer.length < 3 + ulen + plen) return;
        const user = buffer.subarray(2, 2 + ulen).toString(),
          pass = buffer.subarray(3 + ulen, 3 + ulen + plen).toString();
        if (user !== 'user' || pass !== 'pass') {
          socket.end(Buffer.from([1, 1]));
          return;
        }
        authenticated++;
        buffer = buffer.subarray(3 + ulen + plen);
        state = 'connect';
        fragmented(Buffer.from([1, 0]));
      }
      if (state === 'connect') {
        if (buffer.length < 5) return;
        const type = buffer[3]!;
        const len = type === 1 ? 4 : type === 3 ? buffer[4]! : 16;
        const start = type === 3 ? 5 : 4;
        if (buffer.length < start + len + 2) return;
        const hostname =
          type === 1
            ? Array.from(buffer.subarray(start, start + len)).join('.')
            : buffer.subarray(start, start + len).toString();
        const port = buffer.readUInt16BE(start + len);
        requests.push(`${hostname}:${port}`);
        const remote = connect({ host: hostname, port });
        sockets.add(remote);
        remote.on('error', () => socket.destroy());
        remote.on('close', () => {
          sockets.delete(remote);
          socket.destroy();
        });
        state = 'tunnel';
        socket.removeListener('data', data);
        const rest = buffer.subarray(start + len + 2);
        remote.once('connect', () => {
          fragmented(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (rest.length) remote.write(rest);
          socket.pipe(remote);
          remote.pipe(socket);
        });
      }
    };
    socket.on('data', data);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return {
    port,
    requests,
    get authenticated() {
      return authenticated;
    },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
