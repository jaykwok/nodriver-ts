import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DisconnectedError, NodriverError } from '../errors.ts';
import { abortReason, bounded, removeTree, type WaitOptions } from '../utils.ts';
import type { StartupProcessDiagnostics } from './startup.ts';

/** Release may have committed even though its acknowledgement was lost. Never retry by killing. */
export class ReleaseUncertainError extends NodriverError {
  override name = 'ReleaseUncertainError';
}
/** The helper did not perform a command: it refused it, or the command never reached it. */
class CommandNotPerformed extends NodriverError {
  override name = 'CommandNotPerformed';
}

const HELPER_PREFIX = 'nodriver-guardian-';
/** Older than any launch that could still be compiling into its directory. */
const STALE_HELPER_MS = 60 * 60 * 1000;
/**
 * @internal Removes helper directories that earlier launches left behind: a released helper keeps
 * its directory while it runs, and a host that dies cannot remove it. Windows refuses to open the
 * executable of a running helper for writing, so a directory still in use stays.
 */
export async function sweepHelperDirectories(root = tmpdir(), now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(HELPER_PREFIX)) continue;
    const directory = join(root, name);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || now - info.mtimeMs < STALE_HELPER_MS) continue;
      await (await open(join(directory, 'guardian.exe'), 'r+')).close();
    } catch (error) {
      // Without an executable, compilation failed. Any other error, such as a running helper: keep.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') continue;
    }
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  }
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
  /** Removal of the compiled helper, once it has exited. */
  private removed: Promise<void> = Promise.resolve();
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
      // Never awaited: cleaning up after earlier launches must not delay or fail this one.
      void sweepHelperDirectories();
      buildDirectory = await mkdtemp(join(tmpdir(), HELPER_PREFIX));
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
            timeout: Math.ceil(Math.min(options.timeout ?? 15000, 15000)),
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
    // Chrome-specific env overrides must not change helper compilation/runtime configuration,
    // and modules preloaded into the helper must not write into its protocol on stdout.
    const helperEnv = { ...process.env };
    delete helperEnv.NODE_OPTIONS;
    const child = spawn(executableHelper, windows ? [] : [helper], {
      detached: true,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: helperEnv,
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
    this.child.stderr!.setEncoding('utf8');
    this.child.stderr!.on('data', (text: string) => {
      this.state.stderr = (this.state.stderr + text).slice(-16384);
    });
    this.child.stdin!.on('error', fail);
    this.child.on('error', fail);
    this.stopped = new Promise<void>((resolve) => {
      this.child.once('close', (code) => {
        // Windows can keep the helper executable locked for a moment after it exits.
        if (buildDirectory) this.removed = removeTree(buildDirectory).catch(() => {});
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
          if (message.error) request?.reject(new CommandNotPerformed(message.error));
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
    if (this.failure)
      throw new CommandNotPerformed(`Browser guardian ${command} not sent`, {
        cause: this.failure,
      });
    const id = ++this.sequence;
    const response = new Promise<void>((resolve, reject) => {
      this.requests.set(id, { resolve, reject });
      this.child.stdin!.write(JSON.stringify({ command, id }) + '\n', (error) => {
        if (error)
          reject(new CommandNotPerformed(`Browser guardian ${command} not sent`, { cause: error }));
      });
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
  /**
   * Hands Chrome over. A command the helper refused or never received leaves Chrome supervised;
   * any other failure is uncertain.
   */
  async release(): Promise<void> {
    try {
      await this.request('release');
    } catch (error) {
      if (error instanceof CommandNotPerformed) throw error;
      // EOF kills an uncommitted browser; committed release survives. Never send terminate.
      this.disconnect();
      throw new ReleaseUncertainError(
        'Guardian release acknowledgement lost; browser may have been released. Reconnect using browser.endpoint to inspect it.',
        { cause: error },
      );
    }
    this.released = true;
    this.disconnect();
  }
  private disconnect(): void {
    this.child.stdin?.destroy();
    this.child.stdout?.destroy();
    this.child.stderr?.destroy();
    this.child.unref();
  }
  /** A failed close is not cached, so a later close() can wait again. */
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      // EOF is the cleanup command, including during helper compilation or Chrome spawn.
      this.child.stdin?.end();
      await bounded(this.stopped, { timeout: 15000 }, 'Browser guardian cleanup');
      await this.removed;
      if (!this.state.exited && this.state.pid) {
        throw new DisconnectedError('Guardian stopped without confirming browser exit');
      }
    })().catch((error: unknown) => {
      this.closing = undefined;
      throw error;
    }));
  }
}
