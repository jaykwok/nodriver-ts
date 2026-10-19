import type { Frame, World } from './frames.ts';
import type { WaitOptions } from '../utils.ts';
import { timeoutValue } from '../utils.ts';
import { abortReason } from '../utils.ts';
import { StaleElementError, TimeoutError } from '../errors.ts';

export interface NavigatorSnapshot {
  userAgent: string;
  platform: string;
  language: string;
  languages: string[];
  hardwareConcurrency: number;
  deviceMemory?: number;
  webdriver?: boolean;
  timezone: string;
  intlLocale: string;
  userAgentData?: Record<string, unknown>;
}
export interface DocumentEnvironment extends NavigatorSnapshot {
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
  };
  viewport: { width: number; height: number; devicePixelRatio: number };
  webgl?: { vendor: string; renderer: string } | { error: string };
}
export interface EnvironmentReport {
  frameId: string;
  url: string;
  document: DocumentEnvironment;
  worker?:
    { status: 'ok'; navigator: NavigatorSnapshot } | { status: 'unavailable'; error: string };
  differences: Array<{ field: keyof NavigatorSnapshot; document: unknown; worker: unknown }>;
}
export interface InspectEnvironmentOptions extends WaitOptions {
  world?: World;
  /** Creates and terminates an ephemeral Blob dedicated Worker. Off by default. */
  worker?: boolean;
  /** Creates a temporary WebGL canvas; does not append it to the document. */
  webgl?: boolean;
}

// Serialized into the browser. Keep this function independent of module state.
async function navigatorSnapshot(): Promise<NavigatorSnapshot> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: {
      toJSON(): Record<string, unknown>;
      getHighEntropyValues(keys: string[]): Promise<Record<string, unknown>>;
    };
  };
  let userAgentData: Record<string, unknown> | undefined;
  if (nav.userAgentData) {
    userAgentData = nav.userAgentData.toJSON();
    try {
      Object.assign(
        userAgentData,
        await nav.userAgentData.getHighEntropyValues([
          'architecture',
          'bitness',
          'model',
          'platformVersion',
          'fullVersionList',
          'wow64',
        ]),
      );
    } catch (error) {
      userAgentData.highEntropyError = String(error);
    }
  }
  const intl = Intl.DateTimeFormat().resolvedOptions();
  return {
    userAgent: nav.userAgent,
    platform: nav.platform,
    language: nav.language,
    languages: [...nav.languages],
    hardwareConcurrency: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    webdriver: nav.webdriver,
    timezone: intl.timeZone,
    intlLocale: intl.locale,
    userAgentData,
  };
}

/** Read-only diagnostics except for explicitly requested temporary canvas/Worker resources. */
export async function inspectEnvironment(
  frame: Frame,
  options: InspectEnvironmentOptions = {},
): Promise<EnvironmentReport> {
  const timeout = timeoutValue(options.timeout ?? 5000);
  const deadline = performance.now() + timeout;
  const generation = frame.generation;
  const session = frame.session;
  const execution = () => {
    if (options.signal?.aborted) throw abortReason(options.signal);
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new TimeoutError('Environment sampling timed out');
    return {
      timeout: remaining,
      signal: options.signal,
      world: options.world ?? ('isolated' as World),
    };
  };
  const assertDocument = () => {
    if (
      frame.detached ||
      session.closed ||
      frame.generation !== generation ||
      frame.session !== session
    )
      throw new StaleElementError('Frame changed during environment sampling');
  };
  assertDocument();
  const document = await frame.evaluate<DocumentEnvironment>(
    `(async()=>{
    const values=await (${navigatorSnapshot.toString()})();
    const result={...values,screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight,colorDepth:screen.colorDepth},viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}};
    ${options.webgl ? `let gl;try {const canvas=document.createElement('canvas');gl=canvas.getContext('webgl');if(!gl)throw Error('WebGL unavailable');const info=gl.getExtension('WEBGL_debug_renderer_info');result.webgl={vendor:String(gl.getParameter(info?info.UNMASKED_VENDOR_WEBGL:gl.VENDOR)),renderer:String(gl.getParameter(info?info.UNMASKED_RENDERER_WEBGL:gl.RENDERER))}}catch(error){result.webgl={error:String(error)}}finally{try{gl?.getExtension('WEBGL_lose_context')?.loseContext()}catch{}}` : ''}
    return result;
  })()`,
    undefined,
    execution(),
  );
  assertDocument();
  const report: EnvironmentReport = {
    frameId: frame.id,
    url: frame.url,
    document,
    differences: [],
  };
  if (!options.worker) return report;
  // The page-side timer starts only once the function runs, so resolve the context first and
  // keep a reserve for dispatch and the reply; the timer then fires before the CDP deadline.
  await frame.context(options.world ?? 'isolated', execution());
  assertDocument();
  const workerExecution = execution();
  const reserve = Math.min(1000, Math.max(100, workerExecution.timeout * 0.2));
  const source = `self.onmessage=async()=>{try{postMessage({status:'ok',navigator:await (${navigatorSnapshot.toString()})()})}catch(error){postMessage({status:'unavailable',error:String(error)})}}`;
  report.worker = await frame.evaluate<
    NonNullable<EnvironmentReport['worker']>,
    { source: string; timeout: number }
  >(
    ({ source, timeout }) =>
      new Promise((resolve) => {
        let worker: Worker | undefined;
        let url: string | undefined;
        let finished = false;
        const timer = setTimeout(
          () => finish({ status: 'unavailable', error: 'Dedicated Worker sampling timed out' }),
          timeout,
        );
        const finish = (value: NonNullable<EnvironmentReport['worker']>) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          worker?.terminate();
          if (url) URL.revokeObjectURL(url);
          resolve(value);
        };
        try {
          url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
          worker = new Worker(url);
          worker.onmessage = (event) =>
            finish(event.data as NonNullable<EnvironmentReport['worker']>);
          worker.onerror = (event) => {
            event.preventDefault();
            finish({
              status: 'unavailable',
              error: event.message || 'Worker creation blocked or failed',
            });
          };
          worker.postMessage(null);
        } catch (error) {
          finish({ status: 'unavailable', error: String(error) });
        }
      }),
    { source, timeout: Math.max(1, workerExecution.timeout - reserve) },
    workerExecution,
  );
  assertDocument();
  if (report.worker.status === 'ok') {
    for (const field of [
      'userAgent',
      'platform',
      'language',
      'languages',
      'hardwareConcurrency',
      'deviceMemory',
      'timezone',
      'intlLocale',
      'userAgentData',
    ] as const) {
      if (stableJSON(document[field]) !== stableJSON(report.worker.navigator[field]))
        report.differences.push({
          field,
          document: document[field],
          worker: report.worker.navigator[field],
        });
    }
  }
  return report;
}

function stableJSON(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}
