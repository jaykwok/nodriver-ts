import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { TimeoutError, NodriverError } from '../errors.ts';

export interface XvfbOptions {
  /** `WIDTHxHEIGHTxDEPTH`; 1920x1080x24 by default. */
  screen?: string;
  /** How long Xvfb may take to report its display; 10 s by default. */
  timeout?: number;
  /** Path or name of the Xvfb program; `Xvfb` on PATH by default. */
  executable?: string;
}
export interface XvfbStartOptions extends XvfbOptions {
  signal?: AbortSignal;
  /** Ends the server when this process exits. On by default. */
  bound?: boolean;
}

const COOKIE_NAME = 'MIT-MAGIC-COOKIE-1';
const FAMILY_WILD = 0xffff;
const STOP_GRACE = 2_000;

/** Throws when these options cannot start a server on this platform. */
export function checkXvfbOptions(options: XvfbOptions): void {
  if (process.platform !== 'linux')
    throw new TypeError('virtualDisplay is only supported on Linux');
  if (options.screen !== undefined && !/^\d{2,5}x\d{2,5}x(8|16|24)$/.test(options.screen))
    throw new RangeError('screen must look like 1920x1080x24');
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0))
    throw new RangeError('timeout must be a positive number');
}

/** One record of an Xauthority file, for any host. An empty `display` matches every display. */
export function xauthRecord(display: string, cookie: Uint8Array): Buffer {
  const field = (bytes: Uint8Array) => {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const family = Buffer.alloc(2);
  family.writeUInt16BE(FAMILY_WILD);
  return Buffer.concat([
    family,
    field(Buffer.alloc(0)),
    field(Buffer.from(display, 'latin1')),
    field(Buffer.from(COOKIE_NAME, 'latin1')),
    field(cookie),
  ]);
}

const running = new Set<XvfbSession>();
function endRunning(): void {
  for (const session of running) session.endNow();
}

/**
 * An Xvfb server on a display it picks itself, reported through -displayfd so that no number is
 * guessed. Clients need the cookie in the file named by `env.XAUTHORITY`; TCP is off.
 */
export class XvfbSession {
  readonly display: string;
  readonly env: { DISPLAY: string; XAUTHORITY: string };
  private readonly child: ChildProcess;
  private readonly directory: string;
  private readonly exited: Promise<void>;
  private stopping?: Promise<void>;
  private constructor(
    child: ChildProcess,
    directory: string,
    number: string,
    exited: Promise<void>,
  ) {
    this.child = child;
    this.directory = directory;
    this.exited = exited;
    this.display = `:${number}`;
    this.env = { DISPLAY: this.display, XAUTHORITY: join(directory, 'client') };
  }
  static async start(options: XvfbStartOptions = {}): Promise<XvfbSession> {
    checkXvfbOptions(options);
    options.signal?.throwIfAborted();
    const directory = await mkdtemp(join(tmpdir(), 'nodriver-xvfb-'));
    const log = join(directory, 'log');
    let child: ChildProcess | undefined;
    try {
      const cookie = randomBytes(16);
      const serverAuth = join(directory, 'server');
      await writeFile(serverAuth, xauthRecord('', cookie), { mode: 0o600 });
      // A file, not a pipe: the server may outlive this process and must not get SIGPIPE.
      const output = await open(log, 'a', 0o600);
      try {
        child = spawn(
          options.executable ?? 'Xvfb',
          [
            '-displayfd',
            '3',
            '-nolisten',
            'tcp',
            '-auth',
            serverAuth,
            '-screen',
            '0',
            options.screen ?? '1920x1080x24',
          ],
          { stdio: ['ignore', 'ignore', output.fd, 'pipe'], detached: true },
        );
      } finally {
        await output.close();
      }
      const started = child;
      const exited = new Promise<void>((resolve) => {
        started.once('close', () => resolve());
        started.once('error', () => resolve());
      });
      const number = await readDisplay(started, options, log);
      await writeFile(join(directory, 'client'), xauthRecord(number, cookie), { mode: 0o600 });
      const session = new XvfbSession(started, directory, number, exited);
      if (options.bound !== false) session.bind();
      return session;
    } catch (error) {
      if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
        const failed = child;
        const gone = new Promise<void>((resolve) => failed.once('close', () => resolve()));
        killGroup(failed, 'SIGKILL');
        await gone;
      }
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }
  private bind(): void {
    if (!running.size) process.on('exit', endRunning);
    running.add(this);
  }
  private unbind(): void {
    if (running.delete(this) && !running.size) process.off('exit', endRunning);
  }
  /** For process exit, where nothing can be awaited. */
  endNow(): void {
    killGroup(this.child, 'SIGKILL');
    rmSync(this.directory, { recursive: true, force: true });
  }
  /** Leaves the server running after this process exits, and its files in place. */
  detach(): void {
    this.unbind();
    this.child.unref();
  }
  /** Ends the server and removes its files. */
  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      this.unbind();
      killGroup(this.child, 'SIGTERM');
      let timer!: NodeJS.Timeout;
      await Promise.race([
        this.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            killGroup(this.child, 'SIGKILL');
            resolve(this.exited);
          }, STOP_GRACE);
        }),
      ]);
      clearTimeout(timer);
      await rm(this.directory, { recursive: true, force: true });
    })());
  }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  // Once it has exited its ID can be reused.
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function readDisplay(child: ChildProcess, options: XvfbStartOptions, log: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const pipe = child.stdio[3] as Readable;
    let text = '';
    const timeout = options.timeout ?? 10_000;
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', aborted);
      child.off('error', failed);
      child.off('close', closed);
      pipe.off('data', data);
      // Nothing more comes, and an open pipe would keep this process alive.
      pipe.destroy();
      settle();
    };
    const failed = (error: Error) => finish(() => reject(error));
    const closed = (code: number | null, signal: NodeJS.Signals | null) => {
      void readFile(log, 'utf8')
        .catch(() => '')
        .then((output) =>
          failed(
            new NodriverError(
              `Xvfb exited (${signal ?? code}) before reporting a display: ${output.slice(-2000)}`,
            ),
          ),
        );
    };
    const aborted = () => failed(options.signal!.reason as Error);
    const data = (chunk: Buffer) => {
      text += chunk.toString('latin1');
      const end = text.indexOf('\n');
      if (end < 0) return;
      const number = text.slice(0, end).trim();
      if (/^\d+$/.test(number)) finish(() => resolve(number));
      else failed(new NodriverError('Xvfb reported an invalid display'));
    };
    const timer = setTimeout(
      () => failed(new TimeoutError(`Xvfb did not report a display within ${timeout}ms`)),
      timeout,
    );
    options.signal?.addEventListener('abort', aborted, { once: true });
    child.once('error', failed);
    child.once('close', closed);
    pipe.on('data', data);
  });
}
