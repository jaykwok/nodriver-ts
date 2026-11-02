// Test preload for `npm run test:map` (node --import): wraps every class exported by the package
// entry points and records, per member, the test source locations that call it directly. Calls
// made from library code are not recorded. Each test-file process writes its own trace into the
// NODRIVER_API_TRACE directory. test/api-map.ts decides which members are public.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const output = process.env.NODRIVER_API_TRACE;
if (!output) throw new Error('NODRIVER_API_TRACE must name the trace output directory');
const root = resolve(import.meta.dirname, '..');
const self = resolve(import.meta.filename);
const calls = new Map<string, Set<string>>();

/** The first stack frame outside this file, as a repository-relative "file:line" in test/. */
function caller(): string | undefined {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 6;
  const stack = new Error().stack ?? '';
  Error.stackTraceLimit = limit;
  for (const frame of stack.split('\n').slice(1)) {
    // V8 prints ESM frames as file:// URLs.
    const match = /\(?((?:file:\/\/\/?)?(?:[A-Za-z]:)?[^():]+):(\d+):\d+\)?$/.exec(frame.trim());
    if (!match) continue;
    const path = resolve(match[1]!.startsWith('file:') ? fileURLToPath(match[1]!) : match[1]!);
    if (path === self) continue;
    const file = relative(root, path).replaceAll('\\', '/');
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
// The source module of each package entry point: package.json "exports" mapped from dist to src.
const { exports } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  exports: Record<string, { import: string }>;
};
const classes = new Set<Function>();
for (const target of Object.values(exports)) {
  const source = target.import.replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
  const module = (await import(pathToFileURL(join(root, source)).href)) as Record<string, unknown>;
  for (const value of Object.values(module))
    if (typeof value === 'function' && /^class\b/.test(Function.prototype.toString.call(value)))
      classes.add(value);
}
for (const cls of classes) {
  wrap(cls.prototype, cls.name, '');
  wrap(cls, cls.name, 'static ');
}
process.on('exit', () => {
  const data = Object.fromEntries([...calls].map(([k, v]) => [k, [...v]]));
  // Windows reuses PIDs across the sequential test-file processes.
  writeFileSync(join(output, `${randomUUID()}.json`), JSON.stringify(data));
});
