import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { startBrowserMcpSocketServer, BrowserMcpSocketClientTransport } from '../src/mcp/socket.js';

const token = randomBytes(32).toString('hex');
const service = await startBrowserMcpSocketServer({ tokens: { [token]: 'example' } });
const client = new Client(
  { name: 'socket-example', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
const transport = new BrowserMcpSocketClientTransport({ path: service.path, token });
try {
  await client.connect(transport);
  console.log((await client.listTools()).tools.map((tool) => tool.name));
  console.log(await client.callTool({ name: 'browser_open', arguments: {} }));
} finally {
  await client.close();
  await service.close();
}
