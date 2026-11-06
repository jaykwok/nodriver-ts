import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  access,
  open,
  mkdir,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir, homedir, hostname } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { WebSocketTransport } from '../transport/websocket.ts';
import { PipeTransport } from '../transport/pipe.ts';
import type { Transport } from '../transport/transport.ts';
import type { ConnectionOptions } from '../protocol/connection.ts';
import type { AttachPolicy } from './browser.ts';
import type { InputPolicy } from '../input/behavior.ts';
import { StartupTracker, type StartupProcessDiagnostics } from './startup.ts';
import { Guardian, ReleaseUncertainError } from './guardian.ts';
import { DisconnectedError, NodriverError, ProfileInUseError } from '../errors.ts';
import {
  abortReason,
  bounded,
  CONNECT_TIMEOUT,
  delay,
  poll,
  removeTree,
  timeoutValue,
  type WaitOptions,
} from '../utils.ts';
export interface LaunchOptions extends WaitOptions, ConnectionOptions {
  executablePath?: string;
  /** False by default. Set true when running without a graphical desktop. */
  headless?: boolean;
  /** False by default. True preserves Chromium's native automation flag. */
  automationControlled?: boolean;
  userDataDir?: string;
  /**
   * Called with the profile directory before Chrome starts, to write or check files such as
   * `Local State` (see updateProfileSettings()): for a temporary profile after the library has
   * prepared it, for a userDataDir while this process holds its lock. Bounded by the launch
   * timeout; its signal also aborts at that deadline, so stop writing when it does.
   */
  prepareProfile?: (directory: string, options: WaitOptions) => void | Promise<void>;
  args?: string[];
  transport?: 'websocket' | 'pipe';
  /** Defaults to all. none discovers targets without constructing Tab/Frame models. */
  attach?: AttachPolicy;
  /** Input policy of every tab, including the startup tab and popups; see setDefaultInputPolicy(). */
  inputPolicy?: InputPolicy;
  /**
   * Allow release() to leave Chrome running independently, including on Windows.
   * Requires WebSocket; stderr is discarded so no parent-owned pipe survives handoff.
   * A host crash before release can leave Chrome running. Defaults to false.
   */
  detached?: boolean;
  /**
   * Supervise Chrome until explicit release, including host hard exit, and capture bounded
   * stderr in an independent helper. Requires detached: true and WebSocket. Windows 10+
   * uses a Job Object; macOS/Linux use a process group (helper must remain alive).
   */
  supervised?: boolean;
  env?: NodeJS.ProcessEnv;
  handleSignals?: boolean;
  proxyServer?: string;
  proxyBypassList?: string;
  /** Explicit Chromium routing policy. Unset leaves native WebRTC behavior. */
  webRtcIPHandlingPolicy?:
    | 'default'
    | 'default_public_interface_only'
    | 'default_public_and_private_interfaces'
    | 'disable_non_proxied_udp';
  /** Startup UA string (`--user-agent`); does not synthesize matching UA Client Hints. */
  userAgent?: string;
  /** Chromium language switch (`--lang`); verify Intl, navigator and HTTP values on the host. */
  lang?: string;
  /** Initial window size (`--window-size`). */
  windowSize?: { width: number; height: number };
  /**
   * In headless mode, replaces "HeadlessChrome" in the UA string and UA-CH brands of every page
   * session. Opt-in, false by default: shared/service Workers are separate targets and
   * keep their native UA, creating observable cross-context differences. Dedicated Workers inherit it.
   */
  maskHeadless?: boolean;
  /**
   * "agent" adds flags that remove first-run UI, background throttling and, on Linux, keyring
   * prompts; see AGENT_ARGS.
   */
  preset?: 'default' | 'agent';
}
/**
 * Flags added by preset "agent": no first-run dialogs or bubbles, no background throttling, and
 * `--password-store=basic`, with which Chrome on Linux encrypts saved passwords and cookies with
 * its built-in key instead of the system keyring.
 */
export const AGENT_ARGS = [
  '--disable-search-engine-choice-screen',
  '--password-store=basic',
  '--hide-crash-restore-bubble',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;
async function executableOnPath(names: string[]): Promise<string | undefined> {
  const extensions = process.platform === 'win32' ? ['.exe'] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const name of names)
      for (const ext of extensions) {
        const candidate = join(dir, name + ext);
        try {
          await access(candidate);
          return candidate;
        } catch {}
      }
  return undefined;
}
/**
 * The group has no live member. macOS reports EPERM rather than ESRCH when only zombies remain
 * (such as a leader not yet reaped); every member is our own process, so EPERM cannot mean a
 * live process we may not signal.
 */
function groupGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ESRCH' || (code === 'EPERM' && process.platform === 'darwin');
}
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
/** For each signal, the launched processes that close Chrome on it, with their error handlers. */
const signalOwners = new Map<NodeJS.Signals, Map<BrowserProcess, (error: unknown) => void>>();
const signalListeners = new Map<NodeJS.Signals, () => void>();
/**
 * Closes Chrome when the host receives SIGINT or SIGTERM. One listener per signal serves every
 * launched process: the host is terminated only once all of them have closed, and only if no
 * other handler of the host takes the signal.
 */
function watchSignals(owner: BrowserProcess, onError: (error: unknown) => void): void {
  for (const signal of SIGNALS) {
    let owners = signalOwners.get(signal);
    if (!owners) {
      signalOwners.set(signal, (owners = new Map()));
      const listener = () => {
        // Decided before the host's handlers run: one registered with once() is gone afterwards.
        const hosted = process.listenerCount(signal) > 1;
        const closing = [...(signalOwners.get(signal) ?? [])].map(([owner, onError]) =>
          owner.close().catch((error: unknown) => onError(error)),
        );
        void Promise.allSettled(closing).then(() => {
          // Restore default termination once Chrome is gone, unless the host handles the signal.
          if (!hosted && process.listenerCount(signal) === 0) process.kill(process.pid, signal);
        });
      };
      signalListeners.set(signal, listener);
      process.prependListener(signal, listener);
    }
    owners.set(owner, onError);
  }
}
function unwatchSignals(owner: BrowserProcess): void {
  for (const [signal, owners] of signalOwners) {
    owners.delete(owner);
    if (owners.size) continue;
    process.off(signal, signalListeners.get(signal)!);
    signalOwners.delete(signal);
    signalListeners.delete(signal);
  }
}
export async function findExecutable(explicit?: string): Promise<string> {
  if (explicit) {
    await access(explicit);
    return resolve(explicit);
  }
  if (process.env.CHROME_PATH) return findExecutable(process.env.CHROME_PATH);
  const programFiles = process.env.PROGRAMFILES ?? 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local');
  const candidates =
    process.platform === 'win32'
      ? [
          join(programFiles, 'Google/Chrome/Application/chrome.exe'),
          join(programFilesX86, 'Google/Chrome/Application/chrome.exe'),
          join(localAppData, 'Google/Chrome/Application/chrome.exe'),
          join(programFiles, 'Chromium/Application/chrome.exe'),
          join(localAppData, 'Chromium/Application/chrome.exe'),
          join(programFiles, 'Microsoft/Edge/Application/msedge.exe'),
          join(programFilesX86, 'Microsoft/Edge/Application/msedge.exe'),
          join(localAppData, 'Google/Chrome SxS/Application/chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/opt/google/chrome/chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
            '/usr/bin/microsoft-edge',
            '/opt/microsoft/msedge/msedge',
          ];
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {}
  }
  const found = await executableOnPath(
    process.platform === 'win32'
      ? ['chrome', 'msedge']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'],
  );
  if (found) return found;
  throw new NodriverError('Chrome not found; set executablePath or CHROME_PATH');
}
export class BrowserProcess {
  /**
   * Owned Chrome launched without `detached` on macOS and Linux, where Chrome runs in a process
   * group of its own that would outlive the host. On Windows, Node ends such a child with the host.
   */
  private static bound = new Set<BrowserProcess>();
  private static readonly endBound = (): void => {
    for (const owner of BrowserProcess.bound)
      try {
        process.kill(-owner.child.pid!, 'SIGTERM');
      } catch {}
  };
  private closing?: Promise<void>;
  private closeStarted = false;
  private releasing?: Promise<void>;
  private handedOff = false;
  private exited = false;
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private stderr = '';
  readonly child: ChildProcess;
  readonly profile: string;
  readonly temporary: boolean;
  readonly detached: boolean;
  private lock?: FileHandle;
  private readonly guardian?: Guardian;
  private constructor(
    child: ChildProcess,
    profile: string,
    temporary: boolean,
    detached: boolean,
    lock?: FileHandle,
    guardian?: Guardian,
  ) {
    this.child = child;
    this.profile = profile;
    this.temporary = temporary;
    this.detached = detached;
    this.lock = lock;
    this.guardian = guardian;
    if (guardian) return;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (text: string) => {
      this.stderr = (this.stderr + text).slice(-16_384);
    });
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitCode = code;
      this.exitSignal = signal;
      this.bind(false);
      // Chrome's helpers can outlive their leader, and once the group is empty its ID can be
      // reused: the group is signalled now, never after.
      if (process.platform !== 'win32' && !this.handedOff)
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {}
    });
    child.on('error', (e) => {
      this.stderr = (this.stderr + e.message).slice(-16_384);
      this.exited = true;
      this.bind(false);
    });
    if (process.platform !== 'win32' && !detached) this.bind(true);
  }
  private bind(bound: boolean): void {
    const owners = BrowserProcess.bound;
    if (bound) {
      if (!owners.size) process.on('exit', BrowserProcess.endBound);
      owners.add(this);
    } else if (owners.delete(this) && !owners.size) process.off('exit', BrowserProcess.endBound);
  }
  get pid(): number | undefined {
    return this.guardian ? this.guardian.diagnostics.pid : this.child.pid;
  }
  /** Exit status and recent stderr, for launch failure messages. */
  get diagnostics(): StartupProcessDiagnostics {
    if (this.guardian) return this.guardian.diagnostics;
    return {
      pid: this.pid,
      exited: this.exited,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      stderr: this.stderr,
      stderrStatus: this.detached ? 'discarded' : this.child.stderr ? 'captured' : 'unavailable',
    };
  }
  /** @internal Refresh helper-owned stderr before taking a startup failure snapshot. */
  async captureDiagnostics(): Promise<void> {
    await this.guardian?.snapshot();
  }
  static async start(
    options: LaunchOptions = {},
    startup = new StartupTracker(options.signal),
  ): Promise<{ process: BrowserProcess; transport: Transport; endpoint?: string }> {
    timeoutValue(options.timeout ?? CONNECT_TIMEOUT);
    if (options.signal?.aborted) throw abortReason(options.signal);
    if (options.supervised && (!options.detached || options.transport === 'pipe'))
      throw new TypeError('supervised requires detached: true and WebSocket transport');
    if (options.supervised && !['win32', 'darwin', 'linux'].includes(process.platform))
      throw new TypeError('supervised supports Windows, macOS and Linux');
    if (options.detached && options.transport === 'pipe')
      throw new TypeError(
        'detached requires WebSocket transport; Chrome exits when CDP pipes close',
      );
    const executable = await findExecutable(options.executablePath);
    if (
      options.webRtcIPHandlingPolicy &&
      ![
        'default',
        'default_public_interface_only',
        'default_public_and_private_interfaces',
        'disable_non_proxied_udp',
      ].includes(options.webRtcIPHandlingPolicy)
    )
      throw new TypeError('Invalid WebRTC IP handling policy');
    if (
      options.webRtcIPHandlingPolicy &&
      options.args?.some((a) => a.startsWith('--force-webrtc-ip-handling-policy'))
    )
      throw new TypeError('Use one WebRTC policy source');
    if (options.args?.some((a) => /^--(remote-debugging-|user-data-dir(?:=|$))/.test(a))) {
      throw new TypeError(
        'Use transport/userDataDir options instead of overriding lifecycle flags',
      );
    }
    const temporary = !options.userDataDir;
    if (!temporary && options.webRtcIPHandlingPolicy)
      throw new TypeError(
        'WebRTC policy preparation requires an owned temporary profile; persistent profiles must be configured by their owner',
      );
    startup.enter('profile-preparation');
    const profile = temporary
      ? await mkdtemp(join(tmpdir(), 'nodriver-'))
      : resolve(options.userDataDir!);
    let lock: FileHandle | undefined;
    let processHandle: BrowserProcess | undefined;
    try {
      if (options.webRtcIPHandlingPolicy) {
        await mkdir(join(profile, 'Default'), { recursive: true });
        await writeFile(
          join(profile, 'Default', 'Preferences'),
          JSON.stringify({ webrtc: { ip_handling_policy: options.webRtcIPHandlingPolicy } }),
        );
      }
      if (!temporary) {
        await mkdir(profile, { recursive: true });
        lock = await acquireProfileLock(profile);
        // Never accidentally connect to a different Chrome already using this profile.
        await removeStaleActivePort(profile);
        await checkNativeProfileLock(profile);
      }
      if (options.prepareProfile) {
        const timeout = timeoutValue(options.timeout ?? CONNECT_TIMEOUT);
        const signal = AbortSignal.any(
          [AbortSignal.timeout(timeout), options.signal].filter((s): s is AbortSignal => !!s),
        );
        await bounded(
          Promise.resolve().then(() => options.prepareProfile!(profile, { timeout, signal })),
          { timeout, signal: options.signal },
          'Profile preparation',
        );
      }
      const extraArgs = [...(options.args ?? [])];
      if (options.automationControlled !== true) {
        const disabled = new Set(['AutomationControlled']);
        for (let i = extraArgs.length - 1; i >= 0; i--) {
          const arg = extraArgs[i]!;
          if (arg.startsWith('--disable-blink-features=')) {
            for (const feature of arg.slice('--disable-blink-features='.length).split(','))
              if (feature) disabled.add(feature);
            extraArgs.splice(i, 1);
          } else if (
            arg.startsWith('--enable-blink-features=') &&
            arg.slice('--enable-blink-features='.length).split(',').includes('AutomationControlled')
          ) {
            throw new TypeError('Use automationControlled: true to enable AutomationControlled');
          }
        }
        extraArgs.push(`--disable-blink-features=${[...disabled].join(',')}`);
      }
      const args = ['--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`];
      if (options.headless === true) args.push('--headless=new');
      if (options.preset === 'agent')
        for (const flag of AGENT_ARGS)
          if (!extraArgs.some((a) => a.split('=')[0] === flag.split('=')[0])) args.push(flag);
      if (options.userAgent) args.push(`--user-agent=${options.userAgent}`);
      if (options.lang) {
        new Intl.Locale(options.lang);
        args.push(`--lang=${options.lang}`);
      }
      if (options.windowSize) {
        const { width, height } = options.windowSize;
        if (![width, height].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 16384))
          throw new RangeError('Invalid windowSize');
        args.push(`--window-size=${width},${height}`);
      }
      if (options.proxyServer) args.push(`--proxy-server=${options.proxyServer}`);
      if (options.proxyBypassList) args.push(`--proxy-bypass-list=${options.proxyBypassList}`);
      if (options.webRtcIPHandlingPolicy)
        args.push(`--force-webrtc-ip-handling-policy=${options.webRtcIPHandlingPolicy}`);
      const pipe = options.transport === 'pipe';
      args.push(
        ...(pipe
          ? ['--remote-debugging-pipe']
          : ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']),
      );
      args.push(...extraArgs, 'about:blank');
      startup.enter('process-launch');
      const guardian = options.supervised
        ? await Guardian.create(
            executable,
            args,
            options.env ? { ...process.env, ...options.env } : process.env,
            options,
          )
        : undefined;
      const child =
        guardian?.child ??
        spawn(executable, args, {
          stdio: pipe
            ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe']
            : ['ignore', 'ignore', options.detached ? 'ignore' : 'pipe'],
          env: options.env ? { ...process.env, ...options.env } : process.env,
          windowsHide: true,
          detached: options.detached === true || process.platform !== 'win32',
        });
      processHandle = new BrowserProcess(
        child,
        profile,
        temporary,
        options.detached === true,
        lock,
        guardian,
      );
      startup.process = () => processHandle!.diagnostics;
      if (guardian) await guardian.waitReady(options);
      else
        await new Promise<void>((resolve, reject) => {
          const spawned = () => {
            child.off('error', failed);
            resolve();
          };
          const failed = (error: Error) => {
            child.off('spawn', spawned);
            reject(error);
          };
          child.once('spawn', spawned);
          child.once('error', failed);
        });
      if (options.handleSignals) watchSignals(processHandle, options.onError ?? (() => {}));
      if (pipe) {
        const transport = new PipeTransport(child.stdio[4] as Readable, child.stdio[3] as Writable);
        return { process: processHandle, transport };
      }
      const owner = processHandle;
      startup.enter('port-file');
      const endpoint = await poll(
        async () => {
          if (owner.diagnostics.exited)
            throw new NodriverError(
              `Chrome exited (${owner.diagnostics.exitCode}) before CDP was ready`,
            );
          try {
            const [port, path] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
              .trim()
              .split(/\r?\n/);
            if (port && /^\d+$/.test(port) && path?.startsWith('/devtools/browser/'))
              return `ws://127.0.0.1:${port}${path}`;
          } catch (e) {
            if (!['ENOENT', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? ''))
              throw e;
          }
          return undefined;
        },
        { timeout: options.timeout ?? CONNECT_TIMEOUT, signal: options.signal },
        'Chrome CDP endpoint',
      );
      startup.enter('websocket-connect');
      const transport = await WebSocketTransport.connect(endpoint, options);
      return { process: owner, transport, endpoint };
    } catch (e) {
      await processHandle?.captureDiagnostics();
      startup.fail(e);
      // Cleanup failures must not replace the startup error and its diagnostics.
      if (processHandle) await processHandle.close().catch(() => {});
      else {
        if (lock) {
          await lock.close().catch(() => {});
          await rm(join(profile, LOCK), { force: true }).catch(() => {});
        }
        if (temporary) await removeTree(profile).catch(() => {});
      }
      throw e;
    }
  }
  async waitForExit(ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    while (!this.diagnostics.exited && performance.now() < end) await delay(25);
    return this.diagnostics.exited;
  }
  close(): Promise<void> {
    if (this.releasing)
      return this.releasing
        .catch(() => {})
        .then(() => {
          if (!this.handedOff) return this.closeOnce();
        });
    return this.closeOnce();
  }
  /** A failed close is not cached, so a later close() can retry the shutdown. */
  private closeOnce(): Promise<void> {
    this.closeStarted = true;
    return (this.closing ??= this.closeOwned().catch((e: unknown) => {
      this.closing = undefined;
      throw e;
    }));
  }
  get released(): boolean {
    return this.handedOff;
  }
  /** Relinquish process/profile ownership without terminating Chrome or deleting its profile. */
  release(): Promise<void> {
    if (this.releasing) return this.releasing;
    if (this.closeStarted) return Promise.reject(new NodriverError('Chrome is already closing'));
    if (!this.detached)
      return Promise.reject(new NodriverError('release() requires launch({ detached: true })'));
    if (this.diagnostics.exited)
      return Promise.reject(new NodriverError('Chrome has exited; there is nothing to release'));
    if (this.guardian) return (this.releasing = this.releaseGuardian(this.guardian));
    // Commit before any await: signal cleanup and close() must never kill a handed-off child.
    this.handedOff = true;
    unwatchSignals(this);
    this.child.unref();
    return (this.releasing = this.unlock());
  }
  private async releaseGuardian(guardian: Guardian): Promise<void> {
    // From here a lost reply is ambiguous. The helper decides whether EOF kills or leaves
    // Chrome; the former owner must never issue a kill after a possibly committed release.
    this.handedOff = true;
    try {
      await guardian.release();
    } catch (error) {
      if (!(error instanceof ReleaseUncertainError)) {
        // The helper did not release Chrome, which stays owned.
        this.handedOff = false;
        this.releasing = undefined;
        throw error;
      }
      unwatchSignals(this);
      await this.unlock();
      throw error;
    }
    unwatchSignals(this);
    await this.unlock();
  }
  private async unlock(): Promise<void> {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = undefined;
    await rm(join(this.profile, LOCK), { force: true });
  }
  private signalGroup(signal: NodeJS.Signals): void {
    try {
      process.kill(-this.pid!, signal);
    } catch (e) {
      if (!groupGone(e)) throw e;
    }
  }
  private async groupRunning(): Promise<boolean> {
    try {
      process.kill(-this.pid!, 0);
    } catch (e) {
      if (groupGone(e)) return false;
      throw e;
    }
    if (process.platform !== 'linux') return true;
    // A dead leader does not imply its renderers have exited. Linux may also
    // retain adopted zombies in the group; those cannot write to the profile
    // and cannot be reaped by this controller.
    const processes = await readdir('/proc');
    const active = await Promise.all(
      processes
        .filter((pid) => /^\d+$/.test(pid))
        .map(async (pid) => {
          try {
            const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
            const fields = stat
              .slice(stat.lastIndexOf(')') + 2)
              .trim()
              .split(/\s+/);
            return Number(fields[2]) === this.pid && fields[0] !== 'Z' && fields[0] !== 'X';
          } catch (e) {
            if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code ?? '')) return false;
            throw e;
          }
        }),
    );
    return active.some(Boolean);
  }
  private async waitForGroupExit(ms: number): Promise<boolean> {
    const end = performance.now() + ms;
    do {
      if (!(await this.groupRunning())) return true;
      await delay(25);
    } while (performance.now() < end);
    return !(await this.groupRunning());
  }
  private async closeOwned(): Promise<void> {
    unwatchSignals(this);
    if (this.guardian) await this.guardian.close();
    else if (this.pid) {
      if (process.platform === 'win32' && !this.exited) {
        // Terminated directly: starting a process such as taskkill can take seconds on a busy
        // host. Chrome's other processes exit on their own once the browser process is gone.
        this.child.kill();
      } else if (process.platform !== 'win32') {
        // Once the leader has exited, its exit handler has signalled the group.
        if (!this.exited) this.signalGroup('SIGTERM');
        if (!(await this.waitForGroupExit(1500)) && !this.exited) this.signalGroup('SIGKILL');
        if (!(await this.waitForGroupExit(5000)))
          throw new DisconnectedError(`Owned Chrome process group ${this.pid} did not exit`);
      }
      // Windows can take seconds to tear down a terminated process.
      if (!(await this.waitForExit(15_000)))
        throw new DisconnectedError(`Owned Chrome PID ${this.pid} did not exit`);
    }
    await this.unlock();
    if (this.temporary) await removeTree(this.profile);
    else await rm(join(this.profile, 'DevToolsActivePort'), { force: true });
  }
}

/**
 * Rejects while a Chrome still serves the endpoint recorded in the profile's DevToolsActivePort.
 * Removes the file when nothing answers there: a Chrome killed before a clean shutdown (for
 * example together with an MCP server its host terminated) leaves it behind.
 */
async function removeStaleActivePort(profile: string): Promise<void> {
  const path = join(profile, 'DevToolsActivePort');
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const [port, browserPath = ''] = contents.trim().split(/\r?\n/);
  const live = await fetch(`http://127.0.0.1:${Number(port)}/json/version`, {
    signal: AbortSignal.timeout(1000),
  })
    .then(
      async (response) =>
        (
          (await response.json()) as { webSocketDebuggerUrl?: string }
        ).webSocketDebuggerUrl?.endsWith(browserPath) === true,
    )
    // Nothing answering there, or something other than Chrome's DevTools endpoint.
    .catch(() => false);
  if (live)
    throw new ProfileInUseError(
      profile,
      `Chrome is serving this profile on port ${port}; use connect(), or close that Chrome first`,
    );
  await rm(path, { force: true });
}

/**
 * Windows Chrome holds lockfile with exclusive sharing. Node reports EBUSY for the sharing
 * violation. Mere existence (including an unlocked file left after a crash) is not ownership.
 * Do not classify EACCES/EPERM as an owner: they can be filesystem permissions.
 * Unix SingletonLock/SingletonSocket need separate platform-specific validation.
 */
async function checkNativeProfileLock(profile: string): Promise<void> {
  if (process.platform !== 'win32') return;
  let handle: FileHandle;
  try {
    handle = await open(join(profile, 'lockfile'), 'r+');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if ((error as NodeJS.ErrnoException).code === 'EBUSY')
      throw new ProfileInUseError(
        profile,
        'Chrome holds this profile lock; connect to its debugging endpoint, or close that Chrome first',
      );
    throw error;
  }
  await handle.close();
}

const LOCK = '.nodriver.lock';
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
/**
 * Exclusive profile lock containing "pid\nhostname". A lock left by a dead local process (crash,
 * kill -9) is replaced; locks held by live processes or other hosts are respected.
 */
export async function acquireProfileLock(profile: string): Promise<FileHandle> {
  const path = join(profile, LOCK);
  const create = async () => {
    const handle = await open(path, 'wx');
    try {
      await handle.writeFile(`${process.pid}\n${hostname()}\n`);
      return handle;
    } catch (e) {
      await handle.close();
      await rm(path, { force: true });
      throw e;
    }
  };
  try {
    return await create();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  // A contender that needed no recovery can still create the lock first.
  const claim = async () => {
    try {
      return await create();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      throw new ProfileInUseError(profile, 'Another process acquired the profile lock first');
    }
  };
  // Serialize stale-lock deletion. Checking a PID and then unlinking without this guard lets
  // two contenders both read the stale owner and one delete the other's newly acquired lock.
  const recoveryPath = `${path}.reclaim`;
  let recovery: FileHandle;
  try {
    recovery = await open(recoveryPath, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    throw new NodriverError(
      `Profile lock recovery is in progress; if interrupted, remove ${recoveryPath} only after confirming the recorded owner has exited`,
    );
  }
  try {
    await recovery.writeFile(`${process.pid}\n${hostname()}\n`);
    let contents: string;
    try {
      contents = await readFile(path, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      return await claim();
    }
    const [pid, host] = contents.split('\n');
    const owner = Number(pid);
    if (!Number.isSafeInteger(owner) || owner <= 0 || host !== hostname() || alive(owner)) {
      const message = `Profile is locked by ${owner > 0 ? `PID ${owner} on ${host || 'an unknown host'}` : 'another process'}; remove ${path} only after confirming it has exited`;
      if (host === hostname() && Number.isSafeInteger(owner) && owner > 0 && alive(owner))
        throw new ProfileInUseError(profile, message);
      throw new NodriverError(message);
    }
    await rm(path, { force: true });
    return await claim();
  } finally {
    await recovery.close();
    await rm(recoveryPath, { force: true });
  }
}
