import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Browser } from '../browser/browser.ts';
import type { Tab } from '../page/tab.ts';
import type { NativeEnvironment } from './native-environment.ts';
import { bounded, within, type WaitOptions } from '../utils.ts';
import { UnsupportedError } from '../errors.ts';

interface Sample {
  timezone: string;
  locale: string;
  language: string;
  languages: string[];
}
const scopes = ['document', 'dedicated', 'shared', 'service'] as const;
/** @internal Missing evidence is a failure, never a match. */
export function checkNativeSamples(value: unknown, expected: NativeEnvironment): void {
  if (!value || typeof value !== 'object')
    throw new UnsupportedError('Native environment probe returned no samples');
  const values = value as Record<string, Sample> & { error?: unknown };
  if (typeof values.error === 'string')
    throw new UnsupportedError(`Native environment probe failed: ${values.error.slice(0, 300)}`);
  const canonical = (locale: string) => Intl.getCanonicalLocales(locale)[0];
  // Chrome and Node may name one zone by different aliases; both resolve through Node's ICU.
  const zone = (timeZone: string) =>
    new Intl.DateTimeFormat('en', { timeZone }).resolvedOptions().timeZone;
  const language = new Intl.Locale(expected.locale).language;
  for (const scope of scopes) {
    const sample = values[scope];
    try {
      if (
        !sample ||
        typeof sample.timezone !== 'string' ||
        typeof sample.locale !== 'string' ||
        typeof sample.language !== 'string' ||
        zone(sample.timezone) !== zone(expected.timezone) ||
        // Chrome resolves the default Intl locale to a UI language it ships, which can drop the
        // region (fr for fr-FR); every context must still resolve the same one.
        new Intl.Locale(sample.locale).language !== language ||
        canonical(sample.locale) !== canonical(values.document!.locale) ||
        canonical(sample.language) !== expected.locale ||
        !Array.isArray(sample.languages) ||
        sample.languages.length === 0 ||
        sample.languages.some((language) => typeof language !== 'string') ||
        canonical(sample.languages[0]!) !== expected.locale ||
        JSON.stringify(sample.languages.map(canonical)) !==
          JSON.stringify(values.document!.languages.map(canonical))
      )
        throw new Error('mismatch');
    } catch {
      throw new UnsupportedError(
        `Native environment verification failed for ${scope}; check Chrome locale support and host configuration`,
      );
    }
  }
}

const sample = `() => { const intl = new Intl.DateTimeFormat().resolvedOptions(); return {
  timezone: intl.timeZone, locale: intl.locale, language: navigator.language, languages: [...navigator.languages]
}; }`;

/**
 * @internal A disposable loopback page samples native defaults before launch returns. Scripts
 * run only in this owned diagnostic page and its Workers; no user-page prototypes are changed.
 */
export async function verifyNativeEnvironment(
  browser: Browser,
  expected: NativeEnvironment,
  step: () => WaitOptions,
): Promise<void> {
  const prefix = `/${randomUUID()}/`;
  let resolveReport!: (value: unknown) => void, rejectReport!: (error: unknown) => void;
  const report = {
    promise: new Promise<unknown>((resolve, reject) => {
      resolveReport = resolve;
      rejectReport = reject;
    }),
    resolve: (value: unknown) => resolveReport(value),
    reject: (error: unknown) => rejectReport(error),
  };
  void report.promise.catch(() => {});
  let origin = '';
  let acceptLanguage: string | undefined;
  const server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    if (request.headers.host !== new URL(origin).host || !request.url?.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const route = request.url.slice(prefix.length);
    if (request.method === 'GET' && route === 'page')
      acceptLanguage = request.headers['accept-language'];
    if (request.method === 'POST' && route === 'report' && request.headers.origin === origin) {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 16384) {
          request.destroy();
          report.reject(new UnsupportedError('Native probe response too large'));
        } else chunks.push(chunk);
      });
      request.on('error', (error) => report.reject(error));
      request.on('end', () => {
        try {
          report.resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          report.reject(error);
        }
        response.end('ok');
      });
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    response.setHeader(
      'content-type',
      route === 'page' ? 'text/html; charset=utf-8' : 'text/javascript',
    );
    if (route === 'dedicated.js') response.end(`postMessage((${sample})());`);
    else if (route === 'shared.js')
      response.end(`onconnect = e => { e.ports[0].postMessage((${sample})()); };`);
    else if (route === 'service.js')
      response.end(
        `oninstall = e => e.waitUntil(skipWaiting()); onactivate = e => e.waitUntil(clients.claim()); onmessage = e => e.ports[0].postMessage((${sample})());`,
      );
    else if (route === 'page')
      response.end(`<!doctype html><meta charset="utf-8"><title>Native environment check</title><script>
      (async () => {
        let worker, shared, registration;
        let values;
        const receive = source => new Promise((resolve, reject) => {
          source.onmessage = e => resolve(e.data); source.onmessageerror = () => reject(new Error('Worker message failed'));
        });
        try {
          values = { document: (${sample})() };
          worker = new Worker('dedicated.js');
          values.dedicated = await receive(worker);
          shared = new SharedWorker('shared.js');
          values.shared = await receive(shared.port);
          registration = await navigator.serviceWorker.register('service.js');
          await navigator.serviceWorker.ready;
          const channel = new MessageChannel(); const pending = receive(channel.port1);
          registration.active.postMessage('sample', [channel.port2]);
          values.service = await pending; channel.port1.close();
        } catch (error) { values = { ...values, error: String(error) }; }
        finally { worker?.terminate(); shared?.port.close(); if (registration) await registration.unregister(); }
        await fetch('report', { method: 'POST', body: JSON.stringify(values), credentials: 'omit' });
      })();
    </script>`);
    else response.writeHead(404).end();
  });
  let tab: Tab | undefined;
  let failure: { error: unknown } | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    tab = await browser.newTab(`${origin}${prefix}page`, undefined, step());
    const values = await bounded(report.promise, step(), 'Native environment verification');
    checkNativeSamples(values, expected);
    const primary = acceptLanguage?.split(',')[0]?.split(';')[0]?.trim();
    if (!primary || Intl.getCanonicalLocales(primary)[0] !== expected.locale)
      throw new UnsupportedError('Native environment verification failed for HTTP Accept-Language');
  } catch (error) {
    failure = { error };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (tab) {
      const closing = tab.close();
      const reportClose = (error: unknown) => browser.reportCloseFailure(tab!.id, error);
      await within(closing, step, reportClose).catch((error) => {
        if (failure) reportClose(error);
        else failure = { error };
      });
      // Only this probe used the origin; storageState() and clearSiteData() need not visit it.
      tab.context.forgetOrigin(origin);
    }
  }
  if (failure) throw failure.error;
  step();
}
