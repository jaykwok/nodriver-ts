import type { Tab, Environment } from './tab.js';
import type { EnvironmentReport, NavigatorSnapshot } from './environment.js';
import type { WaitOptions } from '../utils.js';
import { StaleElementError } from '../errors.js';
import { timeoutValue } from '../utils.js';
export interface DiagnoseEnvironmentOptions extends WaitOptions {
  worker?: boolean;
  webgl?: boolean;
  /** Actual selected platform fonts in the current document. DOM/CSS diagnostic domains are enabled explicitly. */
  fontSelectors?: string[];
  /** Explicit opt-in only. Browser fetch: no credentials, redirects rejected. Expected JSON {ip, headers?}. */
  httpProbe?: string;
  /** Empty array means native local ICE only. No media/audio/video permission is requested. */
  stunServers?: string[];
  siteAssessments?: Array<{ site: string; label: string; observedAt: string }>;
  /** Only reads location if permission is already granted; never prompts/grants it. */
  geolocation?: boolean;
}
export interface Observation<T> {
  status: 'observed' | 'unavailable' | 'not-requested';
  source: 'browser' | 'explicit-configuration' | 'site-assessment' | 'resolver';
  value?: T;
  error?: string;
}
export interface EnvironmentDiagnostics {
  sampledAt: string;
  browser: string;
  frames: EnvironmentReport[];
  nativeBaseline: ReturnType<Tab['environmentState']>['nativeBaseline'];
  overrides: ReturnType<Tab['environmentState']>;
  fonts: Observation<Array<{ frameId: string; selector: string; fonts: unknown[] }>>;
  http: Observation<{
    endpoint: string;
    ip?: string;
    headers?: Record<string, string>;
    httpStatus: number;
  }>;
  webrtc: Observation<{
    candidates: Array<{ address: string | null; type: string | null; protocol: string | null }>;
    errors: unknown[];
    complete: boolean;
  }>;
  routing: Tab['browser']['networkPolicy'] & {
    contextProxyConfigured: boolean;
    enforcement: 'launch-requested-only; inspect candidates for observed effects';
  };
  siteAssessments: Observation<NonNullable<DiagnoseEnvironmentOptions['siteAssessments']>>;
  geolocation: Observation<{ latitude: number; longitude: number; accuracy: number }>;
  notes: string[];
}
export interface GeoIPResult {
  timezone?: string;
  geolocation?: Environment['geolocation'];
  label?: string;
}
export type GeoIPResolver = (address: string, options: WaitOptions) => Promise<GeoIPResult>;
export interface AlignEnvironmentOptions extends WaitOptions {
  environment?: Environment;
  geoip?: { address: string; fields: Array<'timezone' | 'geolocation'> };
  inspect?: Omit<DiagnoseEnvironmentOptions, 'signal' | 'timeout'>;
}
export interface EnvironmentVerification {
  field: string;
  scope: string;
  status: 'match' | 'mismatch' | 'unavailable' | 'not-tested';
  expected: unknown;
  actual?: unknown;
}
export async function diagnoseEnvironment(
  tab: Tab,
  options: DiagnoseEnvironmentOptions = {},
): Promise<EnvironmentDiagnostics> {
  const deadline = performance.now() + timeoutValue(options.timeout ?? 10000),
    frame = tab.mainFrame,
    generation = frame.generation;
  const wait = () => {
    options.signal?.throwIfAborted();
    if (performance.now() >= deadline) throw new Error('Environment diagnostic deadline exceeded');
    if (frame.generation !== generation || frame.detached)
      throw new StaleElementError('Document changed during diagnostics');
    return { signal: options.signal, timeout: Math.max(1, deadline - performance.now()) };
  };
  const frames: EnvironmentReport[] = [];
  for (const f of tab.frames)
    frames.push(
      await f.inspectEnvironment({ ...wait(), worker: options.worker, webgl: options.webgl }),
    );
  const report: EnvironmentDiagnostics = {
    sampledAt: new Date().toISOString(),
    browser: tab.browser.version.product,
    frames,
    nativeBaseline: tab.environmentState().nativeBaseline,
    overrides: tab.environmentState(),
    fonts: { status: 'not-requested', source: 'browser' },
    http: { status: 'not-requested', source: 'browser' },
    webrtc: { status: 'not-requested', source: 'browser' },
    geolocation: { status: 'not-requested', source: 'browser' },
    routing: {
      ...tab.browser.networkPolicy,
      contextProxyConfigured: tab.context.proxyConfigured,
      enforcement: 'launch-requested-only; inspect candidates for observed effects',
    },
    siteAssessments: options.siteAssessments
      ? {
          status: 'observed',
          source: 'site-assessment',
          value: structuredClone(options.siteAssessments),
        }
      : { status: 'not-requested', source: 'site-assessment' },
    notes: [
      'Current browser values are observations, not a promise of fingerprint consistency.',
      'A baseline is captured only before the first library override; external CDP/client changes are unknown.',
      'Dedicated Worker sampling does not verify existing Workers, Shared Workers or Service Workers.',
    ],
  };
  if (options.fontSelectors) {
    if (options.fontSelectors.length > 16) throw new RangeError('At most 16 font selectors');
    try {
      const values: NonNullable<EnvironmentDiagnostics['fonts']['value']> = [];
      for (const f of tab.frames) {
        wait();
        await f.session.send('DOM.enable');
        try {
          await f.session.send('CSS.enable');
          try {
            await f.session.send('DOM.getDocument', { depth: 0 });
            for (const selector of options.fontSelectors) {
              const el = await f.query(selector);
              if (!el) continue;
              const { nodeIds } = await f.session.send('DOM.pushNodesByBackendIdsToFrontend', {
                backendNodeIds: [el.backendNodeId],
              });
              const { fonts } = await f.session.send('CSS.getPlatformFontsForNode', {
                nodeId: nodeIds[0]!,
              });
              values.push({ frameId: f.id, selector, fonts });
            }
          } finally {
            // CSS agents track every stylesheet change while enabled; release them promptly.
            await f.session.send('CSS.disable').catch(() => {});
          }
        } finally {
          await f.session.send('DOM.disable').catch(() => {});
        }
      }
      report.fonts = {
        status: values.length ? 'observed' : 'unavailable',
        source: 'browser',
        value: values,
        error: values.length ? undefined : 'No matching text nodes',
      };
    } catch (error) {
      report.fonts = { status: 'unavailable', source: 'browser', error: String(error) };
    }
  }
  if (options.httpProbe) {
    const url = new URL(options.httpProbe);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new TypeError('Use an explicit HTTP(S) probe without URL credentials');
    try {
      const value = await frame.evaluate(
        async ({ url, timeout }) => {
          const controller = new AbortController(),
            timer = setTimeout(() => controller.abort(), timeout);
          try {
            const response = await fetch(url, {
              signal: controller.signal,
              credentials: 'omit',
              cache: 'no-store',
              redirect: 'error',
            });
            const data = (await response.json()) as {
              ip?: string;
              headers?: Record<string, string>;
            };
            return {
              endpoint: url,
              ip: data.ip,
              headers: data.headers,
              httpStatus: response.status,
            };
          } finally {
            clearTimeout(timer);
          }
        },
        { url: url.href, timeout: Math.max(1, wait().timeout - 100) },
        { ...wait(), world: 'isolated' },
      );
      report.http = {
        status: value.httpStatus >= 200 && value.httpStatus < 300 ? 'observed' : 'unavailable',
        source: 'browser',
        value,
      };
    } catch (error) {
      report.http = { status: 'unavailable', source: 'browser', error: String(error) };
    }
  }
  if (options.stunServers) {
    if (
      options.stunServers.length > 4 ||
      options.stunServers.some((s) => !/^stuns?:[a-z0-9.\-\[\]:]+$/i.test(s))
    )
      throw new TypeError('Use at most four explicit STUN endpoints');
    try {
      const value = await frame.evaluate(
        ({ servers, timeout }) =>
          new Promise<{
            candidates: Array<{
              address: string | null;
              type: string | null;
              protocol: string | null;
            }>;
            errors: unknown[];
            complete: boolean;
          }>((resolve) => {
            const candidates: Array<{
                address: string | null;
                type: string | null;
                protocol: string | null;
              }> = [],
              errors: unknown[] = [];
            const peer = new RTCPeerConnection({ iceServers: servers.map((urls) => ({ urls })) });
            let done = false;
            const finish = (complete: boolean) => {
              if (done) return;
              done = true;
              clearTimeout(timer);
              channel.close();
              peer.close();
              resolve({ candidates, errors, complete });
            };
            const channel = peer.createDataChannel('environment-diagnostic'),
              timer = setTimeout(() => finish(false), timeout);
            peer.onicecandidate = (e) => {
              if (e.candidate)
                candidates.push({
                  address: e.candidate.address,
                  type: e.candidate.type,
                  protocol: e.candidate.protocol,
                });
              else finish(true);
            };
            peer.onicecandidateerror = (e) => errors.push({ code: e.errorCode, text: e.errorText });
            peer
              .createOffer()
              .then((o) => peer.setLocalDescription(o))
              .catch((e) => {
                errors.push(String(e));
                finish(false);
              });
          }),
        { servers: options.stunServers, timeout: Math.max(1, wait().timeout - 100) },
        { ...wait(), world: 'isolated' },
      );
      report.webrtc = {
        status: value.complete ? 'observed' : 'unavailable',
        source: 'browser',
        value,
        error: value.complete ? undefined : 'ICE gathering deadline reached; peer closed',
      };
    } catch (error) {
      report.webrtc = { status: 'unavailable', source: 'browser', error: String(error) };
    }
  }
  if (options.geolocation) {
    try {
      const location = await frame.evaluate(
        async (timeout) => {
          const permission = await navigator.permissions.query({ name: 'geolocation' });
          if (permission.state !== 'granted')
            return { error: `Geolocation permission ${permission.state}; no prompt requested` };
          return new Promise<{
            value?: { latitude: number; longitude: number; accuracy: number };
            error?: string;
          }>((resolve) =>
            navigator.geolocation.getCurrentPosition(
              (p) =>
                resolve({
                  value: {
                    latitude: p.coords.latitude,
                    longitude: p.coords.longitude,
                    accuracy: p.coords.accuracy,
                  },
                }),
              (e) => resolve({ error: e.message }),
              { timeout, maximumAge: 0 },
            ),
          );
        },
        Math.max(1, wait().timeout - 100),
        { ...wait(), world: 'isolated' },
      );
      report.geolocation = location.value
        ? { status: 'observed', source: 'browser', value: location.value }
        : { status: 'unavailable', source: 'browser', error: location.error };
    } catch (error) {
      report.geolocation = { status: 'unavailable', source: 'browser', error: String(error) };
    }
  }
  wait();
  return report;
}
export async function alignEnvironment(
  tab: Tab,
  options: AlignEnvironmentOptions,
  resolver?: GeoIPResolver,
) {
  if (options.geoip && !resolver)
    throw new TypeError(
      'GeoIP requires a caller-supplied resolver; no default service is contacted',
    );
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const deadline = performance.now() + timeoutValue(options.timeout ?? 10000);
  const remaining = () => Math.max(1, deadline - performance.now());
  const timer = setTimeout(
    () => controller.abort(new Error('Alignment deadline exceeded')),
    remaining(),
  );
  try {
    const before = await tab.diagnoseEnvironment({
      worker: true,
      timeout: remaining(),
      signal,
    });
    let resolved: Observation<GeoIPResult> = { status: 'not-requested', source: 'resolver' };
    const requested: Environment = structuredClone(options.environment ?? {});
    if (options.geoip) {
      if (!resolver)
        throw new TypeError(
          'GeoIP requires a caller-supplied resolver; no default service is contacted',
        );
      options.signal?.throwIfAborted();
      const value = await new Promise<GeoIPResult>((resolve, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) {
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
          return;
        }
        Promise.resolve()
          .then(() => resolver!(options.geoip!.address, { signal, timeout: remaining() }))
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
      options.signal?.throwIfAborted();
      resolved = { status: 'observed', source: 'resolver', value };
      for (const field of options.geoip.fields)
        if (field === 'timezone' && !requested.timezone && value.timezone)
          requested.timezone = value.timezone;
        else if (field === 'geolocation' && !requested.geolocation && value.geolocation)
          requested.geolocation = value.geolocation;
    }
    signal.throwIfAborted();
    let applicationError: string | undefined;
    try {
      await tab.setEnvironment(requested);
    } catch (error) {
      applicationError = String(error);
    }
    const after = await tab.diagnoseEnvironment({
      ...options.inspect,
      worker: true,
      timeout: remaining(),
      signal,
      geolocation: !!requested.geolocation,
    });
    const verification: EnvironmentVerification[] = [];
    const fields: Array<[keyof Environment, keyof NavigatorSnapshot | 'viewport']> = [
      ['timezone', 'timezone'],
      ['locale', 'intlLocale'],
      ['userAgent', 'userAgent'],
      ['viewport', 'viewport'],
    ];
    for (const frame of after.frames)
      for (const [key, observed] of fields) {
        if (requested[key] === undefined) continue;
        const expected =
          key === 'viewport'
            ? {
                width: requested.viewport!.width,
                height: requested.viewport!.height,
                devicePixelRatio: requested.viewport!.deviceScaleFactor ?? 1,
              }
            : requested[key];
        for (const scope of ['document', 'worker'] as const) {
          const snapshot =
            scope === 'document'
              ? frame.document
              : frame.worker?.status === 'ok'
                ? frame.worker.navigator
                : undefined;
          const actual =
            snapshot && observed in snapshot ? Reflect.get(snapshot, observed) : undefined;
          verification.push({
            field: key,
            scope: `${frame.frameId}/${scope}`,
            expected,
            actual,
            status:
              actual === undefined
                ? 'unavailable'
                : JSON.stringify(actual) === JSON.stringify(expected)
                  ? 'match'
                  : 'mismatch',
          });
        }
      }
    if (requested.acceptLanguage)
      verification.push({
        field: 'acceptLanguage',
        scope: 'HTTP',
        expected: requested.acceptLanguage,
        status:
          after.http.value?.headers?.['accept-language'] === undefined
            ? 'not-tested'
            : after.http.value.headers['accept-language'] === requested.acceptLanguage
              ? 'match'
              : 'mismatch',
        actual: after.http.value?.headers?.['accept-language'],
      });
    if (requested.userAgentMetadata)
      for (const frame of after.frames)
        for (const scope of ['document', 'worker'] as const) {
          const actual =
            scope === 'document'
              ? frame.document.userAgentData
              : frame.worker?.status === 'ok'
                ? frame.worker.navigator.userAgentData
                : undefined;
          for (const [field, expected] of Object.entries(requested.userAgentMetadata))
            verification.push({
              field: `userAgentMetadata.${field}`,
              scope: `${frame.frameId}/${scope}`,
              expected,
              actual: actual?.[field],
              status:
                actual?.[field] === undefined
                  ? 'unavailable'
                  : JSON.stringify(actual[field]) === JSON.stringify(expected)
                    ? 'match'
                    : 'mismatch',
            });
        }
    if (requested.geolocation)
      verification.push({
        field: 'geolocation',
        scope: 'permission-dependent navigator.geolocation',
        expected: requested.geolocation,
        status:
          after.geolocation.status === 'observed'
            ? Math.abs(after.geolocation.value!.latitude - requested.geolocation.latitude) <
                0.000001 &&
              Math.abs(after.geolocation.value!.longitude - requested.geolocation.longitude) <
                0.000001
              ? 'match'
              : 'mismatch'
            : 'unavailable',
        actual: after.geolocation.value ?? after.geolocation.error,
      });
    return {
      before,
      applicationError,
      requested,
      resolver: resolved,
      after,
      verification,
      notes: [
        'Only explicitly selected resolver fields are applied. Language, brand and hardware are never inferred from an IP.',
        'Geolocation permission is separate. Unsupported or unverified Worker fields are not marked successful.',
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}
