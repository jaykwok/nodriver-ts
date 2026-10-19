// Test preload for `bun run test:map`: wraps the public classes and records, per member, the test
// source locations that call it directly. Calls made from library code are not recorded.
import { afterAll } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import * as api from '../src/index.js';
import { BrowserSessionManager } from '../src/mcp/manager.js';

const output = process.env.NODRIVER_API_TRACE;
if (!output) throw new Error('NODRIVER_API_TRACE must name the trace output file');
const root = resolve(import.meta.dir, '..');
const self = resolve(import.meta.path);
const calls = new Map<string, Set<string>>();

/** The first stack frame outside this file, as a repository-relative "file:line" in test/. */
function caller(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 6;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  for (const frame of stack.split('\n').slice(1)) {
    const match = /\(?((?:[A-Za-z]:)?[^():]+):(\d+):\d+\)?$/.exec(frame.trim());
    if (!match || resolve(match[1]!) === self) continue;
    const file = relative(root, match[1]!).replaceAll('\\', '/');
    return file.startsWith('test/') ? `${file}:${match[2]}` : undefined;
  }
  return undefined;
}
function record(member: string): void {
  const location = caller();
  if (location) (calls.get(member) ?? calls.set(member, new Set()).get(member)!).add(location);
}
function wrap(target: object, name: string, prefix: string): void {
  for (const key of Reflect.ownKeys(target)) {
    if (['constructor', 'prototype', 'length', 'name'].includes(key as string)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
    const member = `${name}.${prefix}${String(key)}`;
    if (typeof descriptor.value === 'function') {
      const original = descriptor.value as (...args: unknown[]) => unknown;
      descriptor.value = function (this: unknown, ...args: unknown[]) {
        record(member);
        return original.apply(this, args);
      };
    } else if (descriptor.get) {
      const original = descriptor.get;
      descriptor.get = function (this: unknown) {
        record(member);
        return original.call(this);
      };
    } else continue;
    Object.defineProperty(target, key, descriptor);
  }
}
const classes: Record<string, { prototype: object }> = {
  Browser: api.Browser,
  BrowserContext: api.BrowserContext,
  Download: api.Download,
  Tab: api.Tab,
  Frame: api.Frame,
  JSHandle: api.JSHandle,
  Element: api.Element,
  Network: api.Network,
  Route: api.Route,
  Mouse: api.Mouse,
  Keyboard: api.Keyboard,
  Connection: api.Connection,
  Session: api.Session,
  WebSocketTransport: api.WebSocketTransport,
  PipeTransport: api.PipeTransport,
  PipeDecoder: api.PipeDecoder,
  ProxyForwarder: api.ProxyForwarder,
  BrowserSessionManager,
};
for (const [name, cls] of Object.entries(classes)) {
  wrap(cls.prototype, name, '');
  wrap(cls, name, 'static ');
}
// Hooks in a preload are global; rewrite the cumulative trace after each file's tests.
afterAll(() => {
  const data = Object.fromEntries(
    [...calls].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v].sort()]),
  );
  writeFileSync(output, JSON.stringify(data, null, 1));
});
