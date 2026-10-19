import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { BrowserSessionManager, createBrowserMcpServer } from '../src/mcp/server.ts';

const manager = new BrowserSessionManager();
const lease = manager.create('trusted-local-application');
const server = createBrowserMcpServer(
  {},
  { manager, principal: lease.principal, leaseId: lease.id },
);
const client = new Client(
  { name: 'embedded-example', version: '1' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
const [a, b] = InMemoryTransport.createLinkedPair();
try {
  await server.connect(b);
  await client.connect(a);
  console.log(await client.callTool({ name: 'browser_open', arguments: {} }));
} finally {
  await client.close();
  await server.close(); // Shared lease survives adapter close.
  await manager.release(lease.principal, lease.id);
  await manager.close();
}
