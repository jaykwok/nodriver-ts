// Records the selected executable's version, not a live CDP handshake. Browser startup and
// protocol behavior are tested by the suites; metadata collection must not create a profile.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findExecutable } from '../src/index.ts';

const path = await findExecutable();
console.log(`os: ${process.platform} ${process.arch}\nruntime: Node.js ${process.versions.node}`);
console.log(`executable: ${path}`);
const exec = promisify(execFile);
const options = { timeout: 15_000, windowsHide: true, maxBuffer: 64 * 1024 };
// Windows Chrome is a GUI executable: --version is not a reliable console-only invocation.
// Read its PE version resource instead. Pass the path as data, never as PowerShell source.
const { stdout } =
  process.platform === 'win32'
    ? await exec(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          "$ErrorActionPreference = 'Stop'; (Get-Item -LiteralPath $env:NODRIVER_VERSION_EXECUTABLE).VersionInfo.ProductVersion",
        ],
        { ...options, env: { ...process.env, NODRIVER_VERSION_EXECUTABLE: path } },
      )
    : await exec(path, ['--version'], options);
const version = stdout.trim();
if (!version) throw new Error(`No executable version returned for ${path}`);
console.log(`browser executable version: ${version}`);
