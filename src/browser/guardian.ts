import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DisconnectedError, NodriverError } from '../errors.ts';
import { abortReason, bounded, type WaitOptions } from '../utils.ts';
import type { StartupProcessDiagnostics } from './startup.ts';

/** Release may have committed even though its acknowledgement was lost. Never retry by killing. */
export class ReleaseUncertainError extends NodriverError {
  override name = 'ReleaseUncertainError';
}

/** @internal Chrome never inherits the host's private control pipes. */
export class Guardian {
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly stopped: Promise<void>;
  private state: StartupProcessDiagnostics = {
    exited: false,
    exitCode: null,
    signal: null,
    stderr: '',
    stderrStatus: 'captured',
  };
  private sequence = 0;
  private requests = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  private failure?: Error;
  private released = false;
  private closing?: Promise<void>;
  static async create(
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    options: WaitOptions = {},
  ): Promise<Guardian> {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const windows = process.platform === 'win32';
    const helper = fileURLToPath(
      new URL(
        windows
          ? import.meta.url.endsWith('.ts')
            ? './windows-guardian.cs'
            : '../../src/browser/windows-guardian.cs'
          : import.meta.url.endsWith('.ts')
            ? './posix-guardian.ts'
            : './posix-guardian.js',
        import.meta.url,
      ),
    );
    let executableHelper = process.execPath;
    let buildDirectory: string | undefined;
    if (windows) {
      buildDirectory = await mkdtemp(join(tmpdir(), 'nodriver-guardian-'));
      executableHelper = join(buildDirectory, 'guardian.exe');
      try {
        await promisify(execFile)(
          join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32/WindowsPowerShell/v1.0/powershell.exe',
          ),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference='Stop'; Add-Type -Path $env:NODRIVER_GUARDIAN_SOURCE -ReferencedAssemblies System.Web.Extensions -OutputAssembly $env:NODRIVER_GUARDIAN_OUTPUT -OutputType ConsoleApplication",
          ],
          {
            windowsHide: true,
            timeout: Math.min(options.timeout ?? 15000, 15000),
            signal: options.signal,
            encoding: 'utf8',
            maxBuffer: 16384,
            env: {
              ...process.env,
              NODRIVER_GUARDIAN_SOURCE: helper,
              NODRIVER_GUARDIAN_OUTPUT: executableHelper,
            },
          },
        );
      } catch (error) {
        await rm(buildDirectory, { recursive: true, force: true });
        if (options.signal?.aborted) throw abortReason(options.signal);
        throw new NodriverError(
          `Could not compile Windows guardian: ${String(error).slice(-16384)}`,
          { cause: error },
        );
      }
    }
    if (options.signal?.aborted) {
      if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
      throw abortReason(options.signal);
    }
    const child = spawn(executableHelper, windows ? [] : [helper], {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Chrome-specific env overrides must not change helper compilation/runtime configuration.
      env: process.env,
    });
    return new Guardian(child, executable, args, env, buildDirectory);
  }
  private constructor(
    child: ChildProcess,
    executable: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    buildDirectory?: string,
  ) {
    this.child = child;
    let ready!: () => void;
    let failed!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      ready = resolve;
      failed = reject;
    });
    void this.ready.catch(() => {});
    const fail = (error: Error) => {
      if (this.failure || this.released) return;
      this.failure = error;
      failed(error);
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
    };
    this.child.stderr!.on('data', (data: Buffer) => {
      this.state.stderr = (this.state.stderr + data.toString()).slice(-16384);
    });
    this.child.stdin!.on('error', fail);
    this.child.on('error', fail);
    this.stopped = new Promise<void>((resolve) => {
      this.child.once('close', (code) => {
        if (buildDirectory)
          void rm(buildDirectory, { recursive: true, force: true }).catch(() => {});
        if (this.released && code === 0) this.state.exited = true;
        fail(new DisconnectedError(`Browser guardian exited (${code}): ${this.state.stderr}`));
        resolve();
      });
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on('line', (line) => {
      try {
        const message = JSON.parse(line) as {
          type: string;
          id?: number;
          pid?: number;
          exitCode?: number | null;
          signal?: NodeJS.Signals | null;
          stderr?: string;
          error?: string;
        };
        if (message.stderr !== undefined)
          this.state.stderr = Buffer.from(message.stderr, 'base64').toString('utf8').slice(-16384);
        if (message.type === 'started') {
          this.state.pid = message.pid;
          ready();
        } else if (message.type === 'exited') {
          this.state.exited = true;
          this.state.exitCode = message.exitCode ?? null;
          this.state.signal = message.signal ?? null;
        } else if (message.type === 'error')
          fail(new NodriverError(message.error ?? 'Browser guardian failed'));
        if (message.id !== undefined) {
          const request = this.requests.get(message.id);
          this.requests.delete(message.id);
          if (message.error) request?.reject(new NodriverError(message.error));
          else request?.resolve();
        }
      } catch (error) {
        fail(new NodriverError('Invalid browser guardian response', { cause: error }));
      }
    });
    this.child.stdin!.write(JSON.stringify({ executable, args, env }) + '\n');
  }
  get diagnostics(): StartupProcessDiagnostics {
    return { ...this.state };
  }
  async waitReady(options: WaitOptions): Promise<void> {
    await bounded(this.ready, options, 'Browser guardian startup');
  }
  private async request(command: string, timeout = 5000): Promise<void> {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    const response = new Promise<void>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ command, id }) + '\n');
    });
    try {
      await bounded(response, { timeout }, `Browser guardian ${command}`);
    } finally {
      this.requests.delete(id);
    }
  }
  async snapshot(): Promise<void> {
    if (!this.failure && !this.released) await this.request('snapshot', 1000).catch(() => {});
  }
  async release(): Promise<void> {
    try {
      await this.request('release');
      this.released = true;
    } catch (error) {
      // EOF kills an uncommitted browser; committed release survives. Never send terminate.
      throw new ReleaseUncertainError(
        'Guardian release acknowledgement lost; browser may have been released. Reconnect using browser.endpoint to inspect it.',
        { cause: error },
      );
    } finally {
      this.disconnect();
    }
  }
  private disconnect(): void {
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      // EOF is the cleanup command, including during helper compilation or Chrome spawn.
      this.child.stdin?.end();
      await bounded(this.stopped, { timeout: 15000 }, 'Browser guardian cleanup');
      if (!this.state.exited && this.state.pid) {
        throw new DisconnectedError('Guardian stopped without confirming browser exit');
      }
    })());
  }
}
