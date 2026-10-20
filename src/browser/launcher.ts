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
import { DisconnectedError, NodriverError } from '../errors.ts';
import { abortReason, delay, poll, removeTree, timeoutValue, type WaitOptions } from '../utils.ts';
export interface LaunchOptions extends WaitOptions {
  executablePath?: string;
  /** False by default. Set true when running without a graphical desktop. */
  headless?: boolean;
  /** False by default. True preserves Chromium's native automation flag. */
  automationControlled?: boolean;
  userDataDir?: string;
  args?: string[];
  transport?: 'websocket' | 'pipe';
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
  onError?: (error: unknown) => void;
  /** Browser-wide User-Agent (`--user-agent`). Prefer it to per-tab overrides when possible. */
  userAgent?: string;
  /** Browser UI and default Accept-Language (`--lang`), e.g. "en-US". */
  lang?: string;
  /** Initial window size (`--window-size`). */
  windowSize?: { width: number; height: number };
  /**
   * In headless mode, replaces "HeadlessChrome" in the UA string and UA-CH brands of every page
   * session. Defaults to true when headless. Dedicated Workers inherit it; shared/service
   * Workers are separate targets and may keep the native value.
   */
  maskHeadless?: boolean;
  /** "agent" adds flags that remove first-run UI and background throttling; see AGENT_ARGS. */
  preset?: 'default' | 'agent';
}
/** Default deadline for starting Chrome and completing the CDP handshake, in milliseconds. */
export const LAUNCH_TIMEOUT = 30_000;
/** Flags added by preset "agent": no first-run dialogs or bubbles, no background throttling. */
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
  private closing?: Promise<void>;
  private exited = false;
  private exitCode: number | null = null;
  private stderr = '';
  private signalListeners: Array<[NodeJS.Signals, () => void]> = [];
  readonly child: ChildProcess;
  readonly profile: string;
  readonly temporary: boolean;
  private lock?: FileHandle;
  private constructor(child: ChildProcess, profile: string, temporary: boolean, lock?: FileHandle) {
    this.child = child;
    this.profile = profile;
    this.temporary = temporary;
    this.lock = lock;
    child.stderr?.on('data', (b: Buffer) => {
      this.stderr = (this.stderr + b.toString()).slice(-16_384);
    });
    child.on('exit', (code) => {
      this.exited = true;
      this.exitCode = code;
    });
    child.on('error', (e) => {
      this.stderr += e.message;
      this.exited = true;
    });
  }
  get pid(): number | undefined {
    return this.child.pid;
  }
  /** Exit status and recent stderr, for launch failure messages. */
  get diagnostics(): { exited: boolean; exitCode: number | null; stderr: string } {
    return { exited: this.exited, exitCode: this.exitCode, stderr: this.stderr };
  }
  static async start(
    options: LaunchOptions = {},
  ): Promise<{ process: BrowserProcess; transport: Transport; endpoint?: string }> {
    timeoutValue(options.timeout ?? LAUNCH_TIMEOUT);
    if (options.signal?.aborted) throw abortReason(options.signal);
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
      const child = spawn(executable, args, {
        stdio: pipe ? ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'ignore', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      processHandle = new BrowserProcess(child, profile, temporary, lock);
      if (options.handleSignals)
        for (const signal of ['SIGINT', 'SIGTERM'] as const) {
          const listener = () => {
            void processHandle!.close().catch(options.onError ?? (() => {}));
          };
          process.on(signal, listener);
          processHandle.signalListeners.push([signal, listener]);
        }
      if (pipe) {
        const transport = new PipeTransport(child.stdio[4] as Readable, child.stdio[3] as Writable);
        return { process: processHandle, transport };
      }
      const owner = processHandle;
      const endpoint = await poll(
        async () => {
          if (owner.exited)
            throw new NodriverError(
              `Chrome exited (${owner.exitCode}) before CDP was ready:\n${owner.stderr}`,
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
        { timeout: options.timeout ?? LAUNCH_TIMEOUT, signal: options.signal },
        'Chrome CDP endpoint',
      );
      const transport = await WebSocketTransport.connect(endpoint, options);
      return { process: owner, transport, endpoint };
    } catch (e) {
      if (processHandle) await processHandle.close();
      else {
        if (lock) {
          await lock.close();
          await rm(join(profile, '.nodriver.lock'), { force: true });
        }
        if (temporary) await removeTree(profile);
      }
      throw e;
    }
  }
  async waitForExit(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.exited && Date.now() < end) await delay(25);
    return this.exited;
  }
  close(): Promise<void> {
    return (this.closing ??= this.closeOwned());
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
    const end = Date.now() + ms;
    do {
      if (!(await this.groupRunning())) return true;
      await delay(25);
    } while (Date.now() < end);
    return !(await this.groupRunning());
  }
  private async closeOwned(): Promise<void> {
    for (const [signal, listener] of this.signalListeners) process.off(signal, listener);
    if (this.pid) {
      if (process.platform === 'win32' && !this.exited) {
        const killer = spawn('taskkill', ['/pid', String(this.pid), '/t', '/f'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await new Promise<void>((resolve, reject) => {
          killer.once('error', reject);
          killer.once('close', () => resolve());
        });
      } else if (process.platform !== 'win32') {
        this.signalGroup('SIGTERM');
        if (!(await this.waitForGroupExit(1500))) this.signalGroup('SIGKILL');
        if (!(await this.waitForGroupExit(5000)))
          throw new DisconnectedError(`Owned Chrome process group ${this.pid} did not exit`);
      }
      if (!(await this.waitForExit(5000)))
        throw new DisconnectedError(`Owned Chrome PID ${this.pid} did not exit`);
    }
    if (this.lock) {
      await this.lock.close();
      await rm(join(this.profile, '.nodriver.lock'), { force: true });
    }
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
  }).then(
    async (response) =>
      ((await response.json()) as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl?.endsWith(
        browserPath,
      ) === true,
    () => false,
  );
  if (live)
    throw new NodriverError(
      `Chrome is serving this profile on port ${port}; use connect(), or close that Chrome first`,
    );
  await rm(path, { force: true });
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
      return await create();
    }
    const [pid, host] = contents.split('\n');
    const owner = Number(pid);
    if (!Number.isSafeInteger(owner) || owner <= 0 || host !== hostname() || alive(owner))
      throw new NodriverError(
        `Profile is locked by ${owner > 0 ? `PID ${owner} on ${host || 'an unknown host'}` : 'another process'}; remove ${path} only after confirming it has exited`,
      );
    await rm(path, { force: true });
    return await create();
  } finally {
    await recovery.close();
    await rm(recoveryPath, { force: true });
  }
}
