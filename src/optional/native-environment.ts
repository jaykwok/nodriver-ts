import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { abortReason, timeoutValue, type WaitOptions } from '../utils.ts';
import { TimeoutError, UnsupportedError } from '../errors.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';

/** Process-wide Linux defaults, inherited by renderers and all Worker processes at startup. */
export interface NativeEnvironment {
  timezone: string;
  locale: string;
}
/** Explicit opt-in: a JSON endpoint returning { timezone: string }; no built-in third party. */
export interface ProxyEnvironmentOptions {
  endpoint: string;
  /** Language is a user preference, never inferred from an IP address. */
  locale: string;
}
/** A language-region tag, the form of glibc locale names (fr-FR for fr_FR.UTF-8). */
function nativeLocale(value: unknown): string {
  let locale: string | undefined;
  try {
    locale = typeof value === 'string' ? Intl.getCanonicalLocales(value)[0] : undefined;
  } catch {}
  if (!locale || !/^[a-z]{2,3}-[A-Z]{2}$/.test(locale))
    throw new TypeError('Use a language-region locale such as fr-FR');
  return locale;
}
/** @internal Validate before launching or contacting the proxy. */
export function nativeEnvironment(
  value: NativeEnvironment,
  platform = process.platform,
): NativeEnvironment {
  if (platform !== 'linux')
    throw new UnsupportedError('Native environment configuration requires Linux');
  if (typeof value.timezone !== 'string' || !/^[A-Za-z0-9_+\-/]+$/.test(value.timezone))
    throw new TypeError('Use an IANA timezone');
  // Intl rejects unknown zones. The name itself is kept: Node reports some current names by
  // legacy aliases (Europe/Kyiv as Europe/Kiev), which newer tzdata ships only as an option.
  new Intl.DateTimeFormat('en', { timeZone: value.timezone });
  return { timezone: value.timezone, locale: nativeLocale(value.locale) };
}
/** @internal Only the child's environment is changed; the Node host remains untouched. */
export function nativeVariables(value: NativeEnvironment): NodeJS.ProcessEnv {
  const lang = value.locale.replaceAll('-', '_') + '.UTF-8';
  return { TZ: value.timezone, LANG: lang, LANGUAGE: value.locale, LC_ALL: lang };
}
/** @internal Refuse missing host data instead of silently falling back to C/UTC. */
export async function checkNativeHost(value: NativeEnvironment, wait: WaitOptions): Promise<void> {
  try {
    await access(join('/usr/share/zoneinfo', value.timezone));
  } catch (error) {
    throw new UnsupportedError(`No timezone data for ${value.timezone} in /usr/share/zoneinfo`, {
      cause: error,
    });
  }
  let stdout: string;
  const deadline = AbortSignal.timeout(Math.ceil(wait.timeout ?? 10000));
  try {
    ({ stdout } = await promisify(execFile)('locale', ['-a'], {
      signal: wait.signal ? AbortSignal.any([wait.signal, deadline]) : deadline,
      maxBuffer: 1024 * 1024,
    }));
  } catch (error) {
    if (wait.signal?.aborted) throw abortReason(wait.signal);
    if (deadline.aborted) throw new TimeoutError('Listing Linux locales timed out');
    throw new UnsupportedError('Could not list Linux locales with locale -a', { cause: error });
  }
  const normalize = (s: string) => s.trim().toLowerCase().replaceAll('-', '');
  const wanted = normalize(nativeVariables(value).LANG!);
  if (!stdout.split(/\r?\n/).some((s) => normalize(s) === wanted))
    throw new UnsupportedError(`Linux locale ${nativeVariables(value).LANG} is not installed`);
}
/**
 * Resolves the timezone through an explicit HTTP(S) proxy. DNS for the destination is left to
 * the proxy; redirects, oversized replies and errors fail closed, without a direct fallback.
 */
export async function resolveProxyEnvironment(
  proxyServer: string,
  options: ProxyEnvironmentOptions,
  wait: WaitOptions = {},
): Promise<NativeEnvironment> {
  const proxy = new URL(proxyServer),
    endpoint = new URL(options.endpoint);
  if (
    !['http:', 'https:'].includes(proxy.protocol) ||
    proxy.pathname !== '/' ||
    proxy.search ||
    proxy.hash
  )
    throw new TypeError('Use one HTTP(S) proxy URL; wrap SOCKS with ProxyForwarder');
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash
  )
    throw new TypeError('Use an HTTP(S) JSON endpoint without URL credentials or fragment');
  nativeLocale(options.locale);
  const timeout = timeoutValue(wait.timeout ?? 10000);
  if (wait.signal?.aborted) throw abortReason(wait.signal);
  const proxyEnv = { HTTP_PROXY: proxy.href, HTTPS_PROXY: proxy.href, NO_PROXY: '' };
  const secure = endpoint.protocol === 'https:';
  const agent = secure ? new HttpsAgent({ proxyEnv }) : new HttpAgent({ proxyEnv });
  // A tunnelled request gets its socket only after CONNECT and TLS, and the agent does not track
  // the proxy socket before then: the deadline settles here and closes every socket directly.
  const sockets = new Set<Duplex>();
  const connect = agent.createConnection;
  agent.createConnection = function (this: unknown, ...args: Parameters<typeof connect>) {
    const socket = connect.apply(this, args);
    if (socket) sockets.add(socket);
    return socket;
  };
  let timer: NodeJS.Timeout | undefined, abort: (() => void) | undefined;
  try {
    return await new Promise<NativeEnvironment>((resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutError('Environment probe timed out')), timeout);
      abort = () => reject(abortReason(wait.signal!));
      wait.signal?.addEventListener('abort', abort, { once: true });
      const req = (secure ? httpsRequest : httpRequest)(
        endpoint,
        { agent, headers: { accept: 'application/json' } },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            reject(new Error(`Environment probe returned HTTP ${response.statusCode}`));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 65536) reject(new RangeError('Environment probe exceeds 64 KiB'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => {
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (
                !value ||
                typeof value !== 'object' ||
                !('timezone' in value) ||
                typeof value.timezone !== 'string'
              )
                throw new TypeError('Environment probe must return { timezone: string }');
              // Validation is platform independent here; launch enforces Linux before probing.
              resolve(
                nativeEnvironment({ timezone: value.timezone, locale: options.locale }, 'linux'),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  } finally {
    clearTimeout(timer);
    if (abort) wait.signal?.removeEventListener('abort', abort);
    agent.destroy();
    for (const socket of sockets) socket.destroy();
  }
}
