import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type WebSocketType from 'ws';
// Bun 1.4.3 replaces bare "ws" imports with a native shim. Resolve the pinned
// npm package's public JS entry for an independent RFC6455 parser and limits.
const require = createRequire(import.meta.url);
const implementation = require(join(dirname(require.resolve('ws/package.json')), 'index.js'));
export const WebSocket: typeof WebSocketType = implementation;
export const WebSocketServer: typeof import('ws').WebSocketServer = implementation.WebSocketServer;
export type WebSocket = WebSocketType;
