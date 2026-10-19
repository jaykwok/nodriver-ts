#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createBrowserMcpServer, type BrowserMcpOptions } from './server.ts';
import { startBrowserMcpHttpServer } from './http.ts';
import { startBrowserMcpSocketServer } from './socket.ts';
import type { BrowserSessionManagerOptions } from './manager.ts';
import type { LaunchOptions } from '../browser/launcher.ts';
import { MCP_PROTOCOL_VERSION } from './protocol.ts';
import { PACKAGE } from '../version.ts';

interface Parsed {
  browser: BrowserSessionManagerOptions;
  transport: 'stdio' | 'http' | 'socket';
  socketPath?: string;
  port: number;
  tokenEnv: string;
}
const LAUNCH_ONLY = [
  '--transport',
  '--browser-transport',
  '--headful',
  '--headless',
  '--executable',
  '--user-data-dir',
  '--user-agent',
  '--lang',
  '--window-size',
  '--preset',
  '--proxy',
];
const LIMITS: Record<string, keyof BrowserSessionManagerOptions> = {
  '--max-browsers': 'maxBrowsers',
  '--contexts-per-browser': 'contextsPerBrowser',
  '--max-leases': 'maxLeases',
  '--lease-idle-ms': 'leaseIdleMs',
  '--queue-limit': 'queueLimit',
  '--operation-timeout': 'operationTimeout',
};
const FLAGS = [
  '--headful',
  '--headless',
  '--read-only',
  '--expose-existing-tabs',
  '--allow-handoff',
];

export function parse(args: string[]): Parsed {
  const launch: LaunchOptions = { transport: 'pipe', preset: 'agent' };
  const options: BrowserMcpOptions = { launch };
  const disabled: string[] = [];
  let endpoint: string | undefined;
  let transport: Parsed['transport'] = 'stdio',
    port = 3100,
    tokenEnv = 'NODRIVER_MCP_TOKEN';
  let socketPath: string | undefined;
  const limits: Partial<BrowserSessionManagerOptions> = {};
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (FLAGS.includes(option)) {
      if (option === '--headful' || option === '--headless') {
        const headless = option === '--headless';
        if (launch.headless !== undefined && launch.headless !== headless)
          throw new TypeError('Choose --headful or --headless, not both');
        launch.headless = headless;
      } else if (option === '--read-only') options.readOnly = true;
      else if (option === '--expose-existing-tabs') options.exposeExistingTabs = true;
      else options.humanInteraction = true;
      continue;
    }
    const value = args[++i];
    if (!value) throw new TypeError(`Missing value for ${option}`);
    if (
      (option === '--transport' || option === '--browser-transport') &&
      ['pipe', 'websocket'].includes(value)
    )
      launch.transport = value as 'pipe' | 'websocket';
    else if (option === '--executable') launch.executablePath = value;
    else if (option === '--user-data-dir') launch.userDataDir = value;
    else if (option === '--user-agent') launch.userAgent = value;
    else if (option === '--lang') launch.lang = value;
    else if (option === '--window-size' && /^\d{2,5}[x,]\d{2,5}$/.test(value)) {
      const [width, height] = value.split(/[x,]/).map(Number) as [number, number];
      launch.windowSize = { width, height };
    } else if (option === '--preset' && ['agent', 'default'].includes(value))
      launch.preset = value as 'agent' | 'default';
    else if (option === '--proxy' && URL.canParse(value)) options.proxy = value;
    else if (option === '--input-policy' && ['instant', 'human'].includes(value))
      options.inputPolicy = { mode: value as 'instant' | 'human' };
    else if (option === '--disable-tool')
      disabled.push(
        ...value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      );
    else if (option === '--upload-dir') options.uploadDir = value;
    else if (option === '--download-dir') options.downloadDir = value;
    else if (option === '--state-dir') options.stateDir = value;
    else if (option === '--endpoint') endpoint = value;
    else if (option === '--mcp-transport' && ['stdio', 'http', 'socket'].includes(value))
      transport = value as typeof transport;
    else if (option === '--socket-path') socketPath = value;
    else if (option === '--port' && /^\d+$/.test(value) && Number(value) <= 65535)
      port = Number(value);
    else if (option === '--token-env' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) tokenEnv = value;
    else if (LIMITS[option] && /^\d+$/.test(value))
      Object.assign(limits, { [LIMITS[option]!]: Number(value) });
    else throw new TypeError(`Unknown option or invalid value: ${option}`);
  }
  if (disabled.length) options.disabledTools = disabled;
  if (endpoint) {
    if (args.some((v) => LAUNCH_ONLY.includes(v)))
      throw new TypeError('--endpoint cannot be combined with launch options');
    delete options.launch;
    options.connect = { endpoint, timeout: 10000 };
  }
  return { browser: { ...options, ...limits }, transport, socketPath, port, tokenEnv };
}

const HELP = `nodriver-mcp ${PACKAGE.version} — MCP ${MCP_PROTOCOL_VERSION} browser server

MCP transport
  --mcp-transport stdio|http|socket   stdio (default) for client-launched use; http for a
                                      long-running loopback service; socket for local IPC
  --port N                            HTTP port (default 3100)
  --socket-path PATH                  socket path (default: per-user location)
  --token-env NAME                    env var holding a >=32 character token (http/socket)

Browser
  --headful | --headless              default headful
  --browser-transport pipe|websocket  CDP transport (default pipe; --transport is an alias)
  --executable PATH                   Chrome/Chromium/Edge binary (default: auto-detect)
  --user-data-dir PATH                persistent profile (single browser, no per-lease contexts)
  --endpoint URL                      connect to a running browser instead of launching
  --expose-existing-tabs              with --endpoint, also expose tabs not opened by this server
  --proxy URL                         upstream proxy; credentials need per-lease contexts
  --user-agent UA | --lang LOCALE | --window-size WxH
  --preset agent|default              agent (default) suppresses first-run UI and throttling

Tools
  --input-policy instant|human        default per-tab input policy
  --read-only                         observation and navigation tools only
  --disable-tool NAME[,NAME]          repeatable
  --upload-dir DIR | --download-dir DIR | --state-dir DIR   enable file tools within DIR
  --allow-handoff                     allow browser_handoff without an explicit --headful

Limits
  --max-browsers N --contexts-per-browser N --max-leases N --lease-idle-ms N
  --queue-limit N --operation-timeout MS

HTTP clients may omit Browser-Lease-Id to use a per-token "default" lease, or send any lease
name (letters, digits, . _ -) to create one on first use. Only MCP ${MCP_PROTOCOL_VERSION} is
accepted; legacy initialize is rejected. Logs go to stderr. Chrome starts lazily. No OS service
or autostart is installed.`;

async function main(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.error(HELP);
    return;
  }
  if (args.includes('--version') || args.includes('-v')) {
    console.log(PACKAGE.version);
    return;
  }
  const options = parse(args);
  const token = process.env[options.tokenEnv];
  if (options.transport !== 'stdio' && (!token || token.length < 32))
    throw new TypeError(
      `Set ${options.tokenEnv} to a local bearer secret of at least 32 characters`,
    );
  const onError = (error: Error) => console.error('[nodriver-mcp]', error.message);
  let handle: { close(): Promise<void> };
  if (options.transport === 'socket') {
    const server = await startBrowserMcpSocketServer({
      tokens: { [token!]: 'local-operator' },
      browser: options.browser,
      path: options.socketPath,
      onError,
    });
    console.error(
      `[nodriver-mcp] Local socket listening at ${server.path}; token is read from ${options.tokenEnv}`,
    );
    handle = server;
  } else if (options.transport === 'http') {
    const server = await startBrowserMcpHttpServer({
      tokens: { [token!]: 'local-operator' },
      browser: options.browser,
      port: options.port,
      onError,
    });
    console.error(
      `[nodriver-mcp] Local HTTP listening at ${server.url}/mcp; token is read from ${options.tokenEnv}`,
    );
    handle = server;
  } else
    handle = serveStdio(() => createBrowserMcpServer(options.browser), {
      legacy: 'reject',
      maxSubscriptions: 4,
      onerror: onError,
    });
  const close = () => {
    void handle.close().catch((error: unknown) => {
      console.error('[nodriver-mcp]', error);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
