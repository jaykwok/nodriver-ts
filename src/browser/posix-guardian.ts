// Internal executable. It outlives the original host after release, draining Chrome stderr.
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { XvfbSession, type XvfbOptions } from '../optional/xvfb.ts';

const CAPACITY = 16384;
let tail = Buffer.alloc(0);
let child: ChildProcess | undefined;
let launching = false;
let display: XvfbSession | undefined;
const displayAbort = new AbortController();
let released = false;
let stopping = false;
let dirty = false;
let lastExit: { exitCode: number | null; signal: NodeJS.Signals | null } | undefined;
function send(message: object): void {
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify(message) + '\n');
}
function snapshot(): string {
  return tail.toString('base64');
}
process.stdout.on('error', () => {
  if (!released) stop();
});
process.stderr.on('error', () => {});
function stop(): void {
  if (released || stopping) return;
  stopping = true;
  clearInterval(report);
  if (!child) {
    // A display still starting ends through this abort, in launch().
    displayAbort.abort(new Error('Guardian stopped'));
    process.stdin.destroy();
    void (display?.stop() ?? Promise.resolve()).finally(() => process.stdout.end());
    return;
  }
  // A leader can exit before its descendants. Always signal the owned group, not just the PID.
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        send({ type: 'error', error: String(error) });
    }
  }
}
const report = setInterval(() => {
  if (dirty && !released && process.stdout.writableLength === 0) {
    dirty = false;
    send({ type: 'stderr', stderr: snapshot() });
  }
}, 100);
const lines = createInterface({ input: process.stdin });
lines.on('close', stop);
lines.on('line', (line) => {
  try {
    const message = JSON.parse(line);
    if (!launching) {
      if (stopping) return;
      launching = true;
      void launch(message);
    } else if (message.command === 'snapshot')
      send({ type: 'snapshot', id: message.id, stderr: snapshot() });
    else if (message.command === 'release') {
      if (stopping || lastExit || !child) {
        send({ type: 'error', id: message.id, error: 'Browser already exited' });
        return;
      }
      // Nothing would end the server once a handed-off Chrome exits.
      if (display) {
        send({ type: 'error', id: message.id, error: 'A virtual display cannot be handed off' });
        return;
      }
      released = true; // Sole commit point: EOF after this point is harmless.
      clearInterval(report);
      tail = Buffer.alloc(0);
      process.stdout.write(JSON.stringify({ type: 'released', id: message.id }) + '\n', () => {
        process.stdin.destroy();
        process.stdout.destroy();
        process.stderr.destroy();
      });
    }
  } catch (error) {
    send({ type: 'error', error: String(error) });
    stop();
  }
});
async function launch(message: {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  virtualDisplay?: XvfbOptions;
}): Promise<void> {
  let env = message.env;
  if (message.virtualDisplay) {
    try {
      display = await XvfbSession.start({
        ...message.virtualDisplay,
        signal: displayAbort.signal,
        bound: false,
      });
    } catch (error) {
      if (stopping) process.stdout.end();
      else {
        send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
        stop();
      }
      return;
    }
    if (stopping) {
      void display.stop().finally(() => process.stdout.end());
      return;
    }
    env = { ...env, ...display.env };
  }
  child = spawn(message.executable, message.args, {
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.once('spawn', () => send({ type: 'started', pid: child!.pid }));
  child.stderr!.on('data', (chunk: Buffer) => {
    if (released) return; // Drain and discard; no original-host pipe dependency.
    tail =
      chunk.length >= CAPACITY
        ? Buffer.from(chunk.subarray(-CAPACITY))
        : Buffer.from(Buffer.concat([tail, chunk]).subarray(-CAPACITY));
    dirty = true;
  });
  child.once('error', (error) => {
    send({ type: 'error', error: error.message });
    stop();
  });
  child.once('exit', (exitCode, signal) => {
    lastExit = { exitCode, signal };
    if (!released) stop();
  });
  child.once('close', () => {
    clearInterval(report);
    if (released) return;
    // The display goes after Chrome, and before the host hears that everything has ended.
    void (display?.stop() ?? Promise.resolve()).finally(() => {
      send({ type: 'exited', ...lastExit, stderr: snapshot() });
      process.stdin.destroy();
      process.stdout.end();
    });
  });
}
