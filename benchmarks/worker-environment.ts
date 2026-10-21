import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { arch, platform, release } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import type { Protocol } from 'devtools-protocol';
import { Browser, type Session, type Command, type Params, type Result } from '../src/index.ts';
import {
  workerContexts,
  workerEnvironmentFixture,
  type WorkerSample,
  type WorkerRequest,
} from './worker-environment-fixture.ts';

const variants = [
  'native',
  'launch-flags',
  'paused-overrides',
  'combined',
  'prepared-navigation',
  'prepared-locale-check',
] as const;
type Variant = (typeof variants)[number];
const markerUA = 'Local-Worker-Audit/1.0';
const requested = { userAgent: markerUA, language: 'fr-FR', locale: 'fr-FR', timezone: 'UTC' };
// Deliberately synthetic fixture identity, not a production fingerprint recommendation.
const metadata: Protocol.Emulation.UserAgentMetadata = {
  brands: [{ brand: 'Local Worker Audit', version: '1' }],
  fullVersionList: [{ brand: 'Local Worker Audit', version: '1.0.0.0' }],
  platform: 'Audit fixture',
  platformVersion: '',
  architecture: '',
  model: '',
  mobile: false,
  bitness: '',
  wow64: false,
};
const filter: Protocol.Target.TargetFilter = [
  ...['page', 'shared_worker', 'service_worker'].map((type) => ({ type })),
  { exclude: true },
];
// Shared/Service Workers are attached at the browser root. Attaching them again at
// the page can double-pause startup and prevent renderer commands from completing.
const childFilter: Protocol.Target.TargetFilter = [
  { type: 'iframe' },
  { type: 'worker' },
  { exclude: true },
];
interface Attachment {
  targetId: string;
  sessionId: string;
  type: string;
  url: string;
  owned: boolean;
  waiting: boolean;
  attachedAt: number;
  parentSessionId?: string;
  duplicate?: boolean;
  deadlineExceeded?: boolean;
  resumedAt?: number;
  resumeError?: string;
  preparedBeforeNavigation?: boolean;
  localeCheck?: {
    before?: string;
    after?: string;
    action: 'unavailable' | 'already-observed' | 'override' | 'override-before-context';
    error?: string;
  };
  commands: Array<{ method: string; status: 'ok' | 'error'; durationMs: number; error?: string }>;
}

function recorder(session: Session, record: Attachment, signal?: AbortSignal) {
  return async <M extends Command>(
    method: M,
    ...params: Params<M>
  ): Promise<Result<M> | undefined> => {
    const start = performance.now();
    try {
      const result = await session.sendWith(method, { timeout: 2000, signal }, ...params);
      record.commands.push({ method, status: 'ok', durationMs: performance.now() - start });
      return result;
    } catch (error) {
      record.commands.push({
        method,
        status: 'error',
        durationMs: performance.now() - start,
        error: String(error),
      });
    }
  };
}

async function checkLocale(command: ReturnType<typeof recorder>, record: Attachment) {
  const observation: NonNullable<Attachment['localeCheck']> = { action: 'unavailable' };
  record.localeCheck = observation;
  if (record.type === 'iframe') {
    // An OOPIF can be paused before it has a default execution context. Retain the
    // explicit override there and use the fixture's first statement for verification.
    observation.action = 'override-before-context';
    await command('Emulation.setLocaleOverride', { locale: requested.locale });
    return;
  }
  async function read() {
    // Controlled fresh fixture contexts only. This executes JS before the fixture's
    // first statement; it does not establish ownership or safety on arbitrary pages.
    const response = await command('Runtime.evaluate', {
      expression: 'Intl.DateTimeFormat().resolvedOptions().locale',
      returnByValue: true,
    });
    if (response?.exceptionDetails || typeof response?.result.value !== 'string') {
      observation.error = response?.exceptionDetails?.text ?? 'Locale read unavailable';
      return undefined;
    }
    return response.result.value as string;
  }
  observation.before = await read();
  if (observation.before === undefined) return;
  if (observation.before.toLowerCase() === requested.locale.toLowerCase()) {
    observation.action = 'already-observed';
    return;
  }
  observation.action = 'override';
  await command('Emulation.setLocaleOverride', { locale: requested.locale });
  // Keep rejected commands even if a concurrent owner subsequently supplies the value.
  observation.after = await read();
}

export function summarizeWorkerEnvironment(samples: WorkerSample[], requests: WorkerRequest[]) {
  const document = samples.find((s) => s.kind === 'document');
  const missing = workerContexts.filter((kind) => !samples.some((s) => s.kind === kind));
  const missingRequests = workerContexts.flatMap((kind) => {
    const initialPath = ['document', 'same-frame', 'cross-frame'].includes(kind)
      ? '/r/'
      : '/worker.js';
    return [
      ...(!requests.some((r) => r.kind === kind && r.path.startsWith(initialPath))
        ? [`${kind}/initial`]
        : []),
      ...(!requests.some((r) => r.kind === kind && r.path === '/sample') ? [`${kind}/sample`] : []),
    ];
  });
  const comparisons = samples
    .filter((s) => s !== document)
    .flatMap((sample) =>
      Object.entries(sample.initial).map(([field, actual]) => ({
        kind: sample.kind,
        field,
        actual,
        expected: document ? Reflect.get(document.initial, field) : undefined,
        status: !document
          ? 'unavailable'
          : isDeepStrictEqual(actual, Reflect.get(document.initial, field))
            ? 'match'
            : 'mismatch',
      })),
    );
  for (const sample of samples.filter((s) => s !== document))
    comparisons.push({
      kind: sample.kind,
      field: 'highEntropy (asynchronous)',
      actual: sample.highEntropy.value,
      expected: document?.highEntropy.value,
      status:
        sample.highEntropy.status !== 'observed' || document?.highEntropy.status !== 'observed'
          ? 'unavailable'
          : isDeepStrictEqual(sample.highEntropy.value, document.highEntropy.value)
            ? 'match'
            : 'mismatch',
    });
  const headers = requests
    .filter((r) => r.kind && workerContexts.includes(r.kind as (typeof workerContexts)[number]))
    .map((request) => {
      const sample = samples.find((s) => s.kind === request.kind);
      // This is a literal observation, not a correctness or automation verdict. Chrome
      // can add language-only fallbacks to HTTP headers. Preserve raw values and q-values.
      const ranges = request.headers['accept-language']
        ?.split(',')
        .map((value) => value.split(';')[0]!.trim().toLowerCase());
      return {
        kind: request.kind,
        path: request.path,
        receivedAt: request.receivedAt,
        userAgent: request.headers['user-agent'],
        acceptLanguage: request.headers['accept-language'],
        clientHints: Object.fromEntries(
          Object.entries(request.headers).filter(([key]) => key.startsWith('sec-ch-ua')),
        ),
        matchesFirstScriptUA: sample
          ? request.headers['user-agent'] === sample.initial.userAgent
          : null,
        matchesFirstScriptLanguages:
          sample && ranges
            ? isDeepStrictEqual(
                ranges,
                sample.initial.languages.map((value) => value.toLowerCase()),
              )
            : null,
      };
    });
  return { missing, missingRequests, comparisons, headers };
}

async function run(
  fixture: Awaited<ReturnType<typeof workerEnvironmentFixture>>,
  variant: Variant,
  transport: 'pipe' | 'websocket',
  repeat: number,
) {
  const name = `${variant}-${transport}-${repeat}`;
  const checkedLocale = variant === 'prepared-locale-check';
  const prepared = variant === 'prepared-navigation' || checkedLocale;
  const startup = variant === 'launch-flags' || variant === 'combined' || prepared;
  const paused = variant === 'paused-overrides' || variant === 'combined' || prepared;
  const commands: Array<{ method: string; sessionId?: string; at: number }> = [];
  const attachments: Attachment[] = [],
    tasks = new Set<Promise<void>>();
  const owners = new Set<string>();
  const errors: string[] = [];
  const browser = await Browser.launch({
    headless: process.env.WORKER_AUDIT_HEADFUL !== '1',
    attach: 'none',
    transport,
    args: ['--disable-extensions'],
    windowSize: { width: 1000, height: 800 },
    ...(startup ? { userAgent: markerUA, lang: requested.language } : {}),
    observe: {
      onSend: (e) => {
        commands.push({ method: e.method, sessionId: e.sessionId, at: e.at });
      },
    },
  });
  const off = browser.connection.events.on((event) => {
    if (event.method !== 'Target.attachedToTarget') return;
    const e = event.params as Protocol.Target.AttachedToTargetEvent;
    const session = browser.connection.session(e.sessionId);
    const record: Attachment = {
      targetId: e.targetInfo.targetId,
      sessionId: e.sessionId,
      type: e.targetInfo.type,
      url: e.targetInfo.url,
      owned:
        fixture.owns(e.targetInfo.url) ||
        (e.targetInfo.url === '' &&
          attachments.some((a) => a.sessionId === event.sessionId && a.owned)),
      waiting: e.waitingForDebugger,
      attachedAt: performance.now(),
      parentSessionId: event.sessionId,
      commands: [],
    };
    attachments.push(record);
    record.duplicate = owners.has(record.targetId);
    owners.add(record.targetId);
    const task = Promise.resolve().then(async () => {
      const controller = new AbortController();
      let resumed: Promise<void> | undefined;
      const resume = () =>
        (resumed ??= session.sendWith('Runtime.runIfWaitingForDebugger', { timeout: 2000 }).then(
          () => {
            record.resumedAt = performance.now();
          },
          (error) => {
            record.resumeError = String(error);
          },
        ));
      const watchdog = setTimeout(() => {
        record.deadlineExceeded = true;
        controller.abort(new Error('Target preparation exceeded 5000ms'));
        void resume();
      }, 5000);
      const command = recorder(session, record, controller.signal);
      try {
        if (!record.owned) return;
        // Release unexpected duplicate pauses immediately. Do not treat this as verified
        // first-script preparation: another session might still be configuring the target.
        if (record.duplicate) {
          errors.push(`Duplicate fixture attachment: ${record.type}`);
          return;
        }
        await command('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
          filter: childFilter,
        });
        await command('Emulation.setUserAgentOverride', {
          userAgent: markerUA,
          acceptLanguage: 'fr-FR,fr',
          userAgentMetadata: metadata,
        });
        await command('Emulation.setTimezoneOverride', { timezoneId: requested.timezone });
        if (checkedLocale) await checkLocale(command, record);
        else await command('Emulation.setLocaleOverride', { locale: requested.locale });
      } finally {
        clearTimeout(watchdog);
        await resume();
      }
    });
    tasks.add(task);
    void task.then(
      () => tasks.delete(task),
      (error) => {
        errors.push(String(error));
        tasks.delete(task);
      },
    );
  });
  try {
    if (paused)
      await browser.cdp.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter,
      });
    const url = `${fixture.origin}/r/${name}/page?${new URLSearchParams({ run: name, kind: 'document' })}`;
    const { targetId } = await browser.cdp.send('Target.createTarget', {
      url: prepared ? 'about:blank' : url,
    });
    if (prepared) {
      while (tasks.size) await Promise.allSettled([...tasks]);
      const record = attachments.find((a) => a.targetId === targetId);
      assert.ok(record, 'Created blank page must have an auto-attached session');
      record.owned = true;
      const session = browser.connection.session(record.sessionId);
      // This page is still blank and has been resumed. Configure before initiating its
      // first real navigation, not merely before accepting its paused-target event.
      await session.sendWith(
        'Target.setAutoAttach',
        { timeout: 2000 },
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: childFilter },
      );
      await session.sendWith(
        'Emulation.setUserAgentOverride',
        { timeout: 2000 },
        { userAgent: markerUA, acceptLanguage: 'fr-FR,fr', userAgentMetadata: metadata },
      );
      await session.sendWith(
        'Emulation.setTimezoneOverride',
        { timeout: 2000 },
        { timezoneId: requested.timezone },
      );
      if (checkedLocale) await checkLocale(recorder(session, record), record);
      else
        await session.sendWith(
          'Emulation.setLocaleOverride',
          { timeout: 2000 },
          { locale: requested.locale },
        );
      record.preparedBeforeNavigation = true;
      await session.sendWith('Page.navigate', { timeout: 10000 }, { url });
    }
    await fixture.wait(name);
    while (tasks.size) await Promise.allSettled([...tasks]);
  } catch (error) {
    errors.push(String(error));
  } finally {
    off();
    // This experiment owns the entire temporary browser. Closing it also cleans up
    // Service Workers and paused targets after a broken transport or probe timeout.
    await browser.close();
    await Promise.allSettled([...tasks]);
  }
  const samples = fixture.samples.filter((s) => s.run === name);
  const requests = fixture.requests.filter((r) => r.run === name);
  const summary = summarizeWorkerEnvironment(samples, requests);
  const forbidden = commands.filter((c) =>
    [
      'Runtime.enable',
      'Console.enable',
      'Debugger.enable',
      'Runtime.addBinding',
      'Page.addScriptToEvaluateOnNewDocument',
    ].includes(c.method),
  );
  if (forbidden.length)
    errors.push(`Unexpected intrusive commands: ${forbidden.map((c) => c.method).join(', ')}`);
  if (summary.missing.length || summary.missingRequests.length)
    errors.push('Incomplete fixture coverage');
  if (attachments.some((a) => a.deadlineExceeded || a.resumeError))
    errors.push('Target preparation/resume failed');
  if (paused && !attachments.some((a) => a.owned && a.type === 'iframe'))
    errors.push('OOPIF target was not observed');
  const cleanup = {
    closed: browser.closed,
    pending: browser.connection.pendingCount,
    listeners: browser.connection.listenerCount,
  };
  if (!cleanup.closed || cleanup.pending || cleanup.listeners)
    errors.push('Connection cleanup did not finish');
  return {
    name,
    variant,
    transport,
    repeat,
    version: browser.version,
    configuration: {
      startup: startup ? { userAgent: markerUA, lang: requested.language } : null,
      pausedOverrides: paused ? { ...requested, userAgentMetadata: metadata } : null,
      localeStrategy: checkedLocale ? 'observe-before-override' : paused ? 'always-override' : null,
    },
    errors,
    cleanup,
    attachments,
    commands,
    samples,
    requests,
    summary,
    requestedFields: samples
      .flatMap((s) =>
        Object.entries(requested)
          .filter(([field]) => paused || (startup && ['userAgent', 'language'].includes(field)))
          .map(([field, expected]) => ({
            kind: s.kind,
            field,
            expected,
            actual: Reflect.get(s.initial, field),
            status: Reflect.get(s.initial, field) === expected ? 'match' : 'mismatch',
          })),
      )
      .concat(
        paused
          ? samples.flatMap((s) =>
              ['brands', 'mobile', 'platform'].map((field) => ({
                kind: s.kind,
                field: `clientHints.${field}`,
                expected: Reflect.get(metadata, field),
                actual:
                  s.initial.clientHints && Reflect.get(s.initial.clientHints as object, field),
                status:
                  s.initial.clientHints === null
                    ? 'unavailable'
                    : isDeepStrictEqual(
                          Reflect.get(metadata, field),
                          Reflect.get(s.initial.clientHints as object, field),
                        )
                      ? 'match'
                      : 'mismatch',
              })),
            )
          : [],
      ),
  };
}

if (import.meta.main) {
  const selected = process.env.WORKER_AUDIT_VARIANTS?.split(',') ?? [...variants];
  const transports = process.env.WORKER_AUDIT_TRANSPORTS?.split(',') ?? ['websocket', 'pipe'];
  const repeats = Number(process.env.WORKER_AUDIT_REPEATS ?? 1);
  assert.ok(selected.every((v) => variants.includes(v as Variant)) && selected.length);
  assert.ok(transports.every((t) => t === 'websocket' || t === 'pipe') && transports.length);
  assert.ok(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 5);
  const output = resolve(process.env.WORKER_AUDIT_REPORT ?? 'test-results/worker-environment.json');
  const fixture = await workerEnvironmentFixture();
  const runs: Awaited<ReturnType<typeof run>>[] = [];
  try {
    for (let repeat = 0; repeat < repeats; repeat++)
      for (const transport of transports)
        for (const variant of selected) {
          const result = await run(
            fixture,
            variant as Variant,
            transport as 'pipe' | 'websocket',
            repeat,
          );
          runs.push(result);
          console.log(
            JSON.stringify({
              name: result.name,
              version: result.version.product,
              samples: result.samples.length,
              errors: result.errors,
              fieldMismatches: result.requestedFields.filter((f) => f.status === 'mismatch').length,
              headerMismatches: result.summary.headers.filter(
                (h) => h.matchesFirstScriptUA === false,
              ).length,
              languageHeaderDifferences: result.summary.headers.filter(
                (h) => h.matchesFirstScriptLanguages === false,
              ).length,
              commandErrors: result.attachments
                .flatMap((a) => a.commands)
                .filter((c) => c.status === 'error').length,
            }),
          );
        }
  } finally {
    await fixture.close();
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      JSON.stringify(
        {
          schemaVersion: 1,
          host: { platform: platform(), release: release(), arch: arch(), node: process.version },
          headful: process.env.WORKER_AUDIT_HEADFUL === '1',
          notes: [
            'Fresh temporary profiles; native is a discover-only CDP connection, not a physical/no-CDP baseline.',
            'Initial synchronous properties are captured by the first statement of the controlled fixture. High-entropy CH is asynchronous.',
            'Initial requests and later sample POSTs are recorded separately. An attached/paused target may already have made requests.',
            'CDP command success, field agreement and requested-value agreement are separate results. Protocol/field differences do not fail this capability experiment.',
            'Language tags do not indicate automation. Header/language-list differences are observations; native fallbacks and preferences must be considered before classifying a regression.',
            'prepared-locale-check reads Intl on the controlled blank page and Workers; paused OOPIFs may not have an execution context yet. Observing the requested locale does not grant override ownership or prove persistence after an owner detaches.',
            'Missing samples, failed resume/cleanup, or forbidden commands do fail the runner.',
            'Fresh worker startup only; persistent profiles, Service Worker update/restart, existing targets and external browser ownership are not certified.',
          ],
          runs,
        },
        null,
        2,
      ) + '\n',
    );
  }
  assert.ok(
    runs.every((r) => r.errors.length === 0),
    `Worker audit incomplete; see ${output}`,
  );
}
