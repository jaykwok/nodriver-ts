import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkAudit, type AuditEvidence } from '../../benchmarks/audit-checks.ts';
import { summarizeAudit } from '../../benchmarks/audit-report.ts';

function fixture(): AuditEvidence {
  const data: AuditEvidence = { runs: [], reports: [], requests: [] };
  const observed = (value: unknown) => ({ status: 'observed', value });
  const environment = {
    userAgent: observed('HeadlessChrome/Test'),
    platform: observed('TestOS'),
    language: observed('en-US'),
    languages: observed(['en-US']),
    hardwareConcurrency: observed(8),
    timezone: observed('UTC'),
    secureContext: observed(true),
    deviceMemory: { status: 'unsupported' },
    clientHints: {
      status: 'observed',
      lowEntropy: { brands: [{ brand: 'Chrome', version: '1' }], mobile: false },
    },
  };
  for (const stage of [
    'A-native',
    'A-matched',
    'B-endpoint',
    'C-raw',
    'D-attached',
    'D-initialized/E-operations',
  ]) {
    const variant = stage === 'D-initialized/E-operations' ? { name: 'default-native' } : undefined;
    const run = variant ? 'D-E-pipe-default-native-0' : `${stage}-0`;
    data.runs.push({ run, stage, variant, repeat: 0 });
    const phases = variant
      ? ['ready', 'dom', 'ax', 'fonts', 'input', 'scroll', 'background-start', 'background-tab']
      : ['ready', 'after-connect-control'];
    if (stage === 'D-attached') phases.push('after-disconnect');
    for (const [phase, lifecycle] of [
      ...phases.map((p) => [p, 'new']),
      ['ready', 'controlled'],
      ...(variant ? [['after-navigation', 'controlled']] : []),
    ]) {
      const workers = Object.fromEntries(
        ['dedicated', 'shared', 'service'].map((kind) => [
          kind,
          {
            status: 'observed',
            environment: structuredClone(environment),
            ...(kind === 'service'
              ? {
                  lifecycle: {
                    active: true,
                    previousRegistration: lifecycle === 'controlled',
                    controlled: true,
                    controllerState: 'activated',
                  },
                }
              : {}),
          },
        ]),
      );
      data.reports.push({
        run,
        phase,
        lifecycle,
        environment: structuredClone(environment),
        workers,
        properties: {
          globals: ['window', 'document'],
          navigator: {},
          navigatorOwn: {},
          window: {},
          chrome: null,
        },
        sideEffects: {
          addedGlobals: [],
          removedGlobals: [],
          mutations:
            phase === 'input'
              ? [{ type: 'attributes', node: 'BUTTON', id: 'click', attribute: 'data-clicks' }]
              : [],
        },
      });
      for (const context of ['document', 'dedicated', 'shared', 'service'])
        data.requests.push({
          run,
          phase,
          lifecycle,
          context,
          headers: { 'user-agent': 'HeadlessChrome/Test' },
        });
    }
    data.reports.push({
      run,
      phase: 'cleanup',
      unregistered: [true],
      remainingRegistrations: 0,
      dedicatedTerminated: true,
      sharedClosed: true,
      animationFrameCancelled: true,
    });
  }
  return data;
}
const sample = (data: AuditEvidence) => data.reports.find((r) => r.phase === 'ax')!;

test('audit checks allow timing/display noise and key ordering, but require complete evidence', () => {
  const data = fixture();
  sample(data).environment.display = { value: { focused: false, width: 1920 } };
  sample(data).timing = { intervalMs: [10, 10000] };
  sample(data).environment.clientHints.lowEntropy = {
    mobile: false,
    brands: [{ version: '1', brand: 'Chrome' }],
  };
  assert.deepEqual(checkAudit(data).failures, []);
  assert.equal(checkAudit({ runs: [], reports: [], requests: [] }).passed, false);
  data.runs = data.runs.filter((r) => r.stage !== 'C-raw');
  assert.ok(checkAudit(data).failures.some((f) => f.check === 'coverage'));
});

test('audit regression gate rejects poisoned evidence rather than silently writing a successful report', () => {
  for (const [name, poison] of [
    [
      'missing Worker',
      (d: AuditEvidence) => {
        sample(d).workers.shared = { status: 'not-observed' };
      },
    ],
    [
      'Worker UA mismatch',
      (d: AuditEvidence) => {
        sample(d).workers.service.environment.userAgent.value = 'Unexpected';
      },
    ],
    [
      'missing request',
      (d: AuditEvidence) => {
        d.requests = d.requests.filter((r) => r.phase !== 'ax');
      },
    ],
    [
      'incorrect request UA',
      (d: AuditEvidence) => {
        d.requests.find((r) => r.phase === 'ax')!.headers['user-agent'] = 'Different';
      },
    ],
    [
      'own navigator patch',
      (d: AuditEvidence) => {
        sample(d).properties.navigatorOwn.fake = { type: 'boolean' };
      },
    ],
    [
      'global injection',
      (d: AuditEvidence) => {
        sample(d).sideEffects.addedGlobals.push('__bridge');
      },
    ],
    [
      'unexpected DOM write',
      (d: AuditEvidence) => {
        sample(d).sideEffects.mutations.push({ type: 'childList', node: 'BODY' });
      },
    ],
    [
      'lost Service Worker control',
      (d: AuditEvidence) => {
        d.reports.find((r) => r.lifecycle === 'controlled')!.workers.service.lifecycle.controlled =
          false;
      },
    ],
    [
      'failed unregister',
      (d: AuditEvidence) => {
        d.reports.find((r) => r.phase === 'cleanup')!.unregistered = [false];
      },
    ],
    [
      'missing operation',
      (d: AuditEvidence) => {
        d.reports = d.reports.filter((r) => r.phase !== 'fonts');
      },
    ],
  ] as const) {
    const data = fixture();
    poison(data);
    assert.equal(checkAudit(data).passed, false, name);
  }
});

test('opt-in UA differences are reported, while unrelated discrepancies still fail', () => {
  const data = fixture();
  const run = data.runs.at(-1)!;
  run.variant = { name: 'default-masked', maskHeadless: true };
  for (const r of data.reports.filter((r) => r.run === run.run && r.environment)) {
    r.environment.userAgent.value = 'Chrome/Test';
    r.workers.dedicated.environment.userAgent.value = 'Chrome/Test';
  }
  for (const r of data.requests.filter(
    (r) => r.run === run.run && ['document', 'dedicated'].includes(r.context),
  ))
    r.headers['user-agent'] = 'Chrome/Test';
  const allowed = checkAudit(data);
  assert.equal(allowed.passed, true, JSON.stringify(allowed.failures));
  assert.ok(allowed.exceptions.some((f) => f.check === 'explicit-override'));
  const invalid = structuredClone(data);
  sample(invalid).workers.service.environment.userAgent.value = 'UnexpectedWorker/Test';
  assert.ok(checkAudit(invalid).failures.some((f) => f.check === 'worker-override'));
  sample(data).workers.service.environment.hardwareConcurrency.value = 64;
  assert.equal(checkAudit(data).passed, false);
});

test('request summaries use their own phase, and attached comparisons use the same document', () => {
  const data = fixture();
  const ax = sample(data);
  ax.environment.userAgent.value = 'ChangedAfterReady';
  data.requests.find(
    (r) => r.run === ax.run && r.phase === 'ax' && r.context === 'document',
  )!.headers['user-agent'] = 'ChangedAfterReady';
  const attached = data.reports.find(
    (r) => r.run === 'D-attached-0' && r.phase === 'after-connect-control',
  )!;
  attached.environment.language.value = 'changed';
  const report = summarizeAudit(data.runs, data.reports, data.requests);
  const requests = report.summaries
    .find((r) => r.run === ax.run)!
    .requestObservations.find((r) => r.context === 'document')!.requests;
  assert.equal(requests.find((r) => r.phase === 'ax')!.matchesContextNavigator, true);
  const diff = report.stageDifferences.find((r) => r.run === 'D-attached-0')!;
  assert.equal(diff.control, 'D-attached-0');
  assert.equal(diff.beforePhase, 'ready/new');
  assert.deepEqual(diff.environmentFields, ['language']);
});
