import { startBrowserMcpHttpServer } from '../src/mcp/http.ts';

const token = process.env.NODRIVER_MCP_TOKEN;
if (!token)
  throw new Error('Set NODRIVER_MCP_TOKEN to a local bearer secret (at least 32 characters)');
const server = await startBrowserMcpHttpServer({
  tokens: { [token]: 'local-operator' },
  browser: { maxBrowsers: 2, contextsPerBrowser: 4 },
});
console.error(`MCP: ${server.url}/mcp; create a browser lease via POST ${server.url}/leases`);
const stop = () => {
  void server.close().catch(console.error);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
