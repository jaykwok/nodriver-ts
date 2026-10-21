import { isDeepStrictEqual } from 'node:util';

type Row = Record<string, any>;
export interface AuditEvidence {
  runs: Row[];
  reports: Row[];
  requests: Row[];
}
export interface AuditFinding {
  run: string;
  phase: string;
  check: string;
  detail: string;
}
const fields = [
  'userAgent',
  'platform',
  'language',
  'languages',
  'hardwareConcurrency',
  'deviceMemory',
  'timezone',
  'secureContext',
  'clientHints',
];
const required = new Set(fields.filter((f) => !['deviceMemory', 'clientHints'].includes(f)));
const contexts = ['dedicated', 'shared', 'service'];
const properties = ['navigator', 'navigatorOwn', 'window', 'chrome'];
const names = (value: unknown) => (Array.isArray(value) ? [...value].sort() : undefined);

/** Controlled localhost Chrome fixture invariants, not a bot-detection verdict or timing gate. */
export function checkAudit(evidence: AuditEvidence) {
  const failures: AuditFinding[] = [],
    exceptions: AuditFinding[] = [];
  let checks = 0;
  const check = (ok: unknown, run: string, phase: string, name: string, detail: string) => {
    checks++;
    if (!ok) failures.push({ run, phase, check: name, detail });
  };
  check(evidence.runs.length > 0, 'audit', '', 'coverage', 'No completed runs');
  for (const repeat of new Set(evidence.runs.map((r) => r.repeat)))
    for (const stage of ['A-native', 'A-matched', 'B-endpoint', 'C-raw', 'D-attached'])
      check(
        evidence.runs.some((r) => r.run === `${stage}-${repeat}`),
        'audit',
        '',
        'coverage',
        `Missing ${stage} control for repeat ${repeat}`,
      );
  const ids = new Set<string>();
  for (const run of evidence.runs) {
    const id = String(run.run);
    check(!ids.has(id), id, '', 'coverage', 'Duplicate run ID');
    ids.add(id);
    const reports = evidence.reports.filter((r) => r.run === id);
    const samples = reports.filter((r) => r.environment);
    const initial = samples.find((r) => r.phase === 'ready' && r.lifecycle === 'new');
    const controlled = samples.find((r) => r.phase === 'ready' && r.lifecycle === 'controlled');
    check(initial && controlled, id, '', 'coverage', 'Missing new or controlled-document sample');
    const phases = run.variant
      ? [
          'dom',
          'ax',
          'fonts',
          'input',
          'scroll',
          'background-start',
          'background-tab',
          'after-navigation',
        ]
      : ['after-connect-control'];
    if (run.stage === 'D-attached') phases.push('after-disconnect');
    for (const phase of phases)
      check(
        samples.some((r) => r.phase === phase),
        id,
        phase,
        'coverage',
        'Missing operation sample',
      );
    check(!reports.some((r) => r.phase === 'probe-error'), id, '', 'probe', 'Page probe failed');
    const cleanup = reports.find((r) => r.phase === 'cleanup');
    check(
      cleanup?.unregistered?.length === 1 && cleanup.unregistered.every((x: unknown) => x === true),
      id,
      'cleanup',
      'cleanup',
      'Expected one successful scoped Service Worker unregistration',
    );
    check(
      cleanup?.remainingRegistrations === 0 &&
        cleanup?.dedicatedTerminated === true &&
        cleanup?.sharedClosed === true &&
        cleanup?.animationFrameCancelled === true,
      id,
      'cleanup',
      'cleanup',
      'Worker or animation-frame cleanup was not confirmed',
    );
    if (!initial || !controlled) continue;
    const baseline = evidence.reports.find(
      (r) => r.run === `C-raw-${run.repeat}` && r.phase === 'ready' && r.lifecycle === 'new',
    );
    const overridden = run.variant?.name === 'explicit-environment';
    const masked = run.variant?.maskHeadless === true;
    const allowed = new Set(
      overridden
        ? ['userAgent', 'language', 'languages', 'timezone', 'clientHints']
        : masked
          ? ['userAgent', 'clientHints']
          : [],
    );
    for (const sample of samples) {
      const phase = `${sample.phase}/${sample.lifecycle}`;
      for (const object of properties) {
        check(
          sample.properties && Object.hasOwn(sample.properties, object),
          id,
          phase,
          'properties',
          `Missing ${object} descriptors`,
        );
        check(
          isDeepStrictEqual(sample.properties?.[object], initial.properties?.[object]),
          id,
          phase,
          'properties',
          `${object} descriptors changed after initialization`,
        );
        if (baseline)
          check(
            isDeepStrictEqual(sample.properties?.[object], baseline.properties?.[object]),
            id,
            phase,
            'properties',
            `${object} descriptors differ from the raw control`,
          );
      }
      check(
        Array.isArray(sample.properties?.globals) &&
          isDeepStrictEqual(names(sample.properties.globals), names(initial.properties?.globals)),
        id,
        phase,
        'globals',
        'Global names changed within the document',
      );
      if (baseline)
        check(
          isDeepStrictEqual(names(sample.properties?.globals), names(baseline.properties?.globals)),
          id,
          phase,
          'globals',
          'Global names differ from the raw control',
        );
      check(
        Array.isArray(sample.sideEffects?.addedGlobals) &&
          sample.sideEffects.addedGlobals.length === 0 &&
          Array.isArray(sample.sideEffects?.removedGlobals) &&
          sample.sideEffects.removedGlobals.length === 0,
        id,
        phase,
        'globals',
        'Page probe observed an added or removed global',
      );
      check(
        Array.isArray(sample.sideEffects?.mutations) &&
          sample.sideEffects.mutations.every(
            (m: Row) =>
              sample.phase === 'input' &&
              m.type === 'attributes' &&
              m.node === 'BUTTON' &&
              m.id === 'click' &&
              m.attribute === 'data-clicks',
          ),
        id,
        phase,
        'dom',
        'Unexpected DOM mutation (only the fixture click counter may change)',
      );
      for (const field of fields) {
        const actual = sample.environment[field];
        const original = baseline?.environment[field];
        check(
          actual?.status === 'observed' ||
            (!required.has(field) && actual?.status === 'unsupported'),
          id,
          phase,
          'environment',
          `Missing or unavailable document ${field}`,
        );
        if (original && !allowed.has(field))
          check(
            isDeepStrictEqual(actual, original),
            id,
            phase,
            'environment',
            `${field} differs from the raw control`,
          );
        if (actual?.status === 'unsupported')
          exceptions.push({
            run: id,
            phase,
            check: 'unsupported-field',
            detail: `${field}: unavailable in this Chrome environment`,
          });
      }
      if (overridden) {
        check(
          sample.environment.userAgent?.value === run.variant.environment.userAgent,
          id,
          phase,
          'override',
          'Explicit document UA was not applied',
        );
        check(
          sample.environment.timezone?.value === run.variant.environment.timezone,
          id,
          phase,
          'override',
          'Explicit document timezone was not applied',
        );
      } else if (masked && baseline) {
        check(
          sample.environment.userAgent?.value ===
            baseline.environment.userAgent.value.replace('HeadlessChrome/', 'Chrome/'),
          id,
          phase,
          'override',
          'Requested headless UA masking was not applied',
        );
      }
      for (const context of contexts) {
        const worker = sample.workers?.[context];
        check(
          worker?.status === 'observed',
          id,
          phase,
          'worker',
          `${context} did not report successfully`,
        );
        if (worker?.status !== 'observed') continue;
        for (const field of fields) {
          const actual = worker.environment?.[field],
            page = sample.environment[field];
          check(
            actual?.status === 'observed' ||
              (!required.has(field) && actual?.status === 'unsupported'),
            id,
            phase,
            'worker',
            `${context}.${field} is missing or unavailable`,
          );
          const original = baseline?.workers?.[context]?.environment?.[field];
          if (original && allowed.has(field))
            check(
              isDeepStrictEqual(actual, original) || isDeepStrictEqual(actual, page),
              id,
              phase,
              'worker-override',
              `${context}.${field} matches neither its native control nor the requested document override`,
            );
          if (original && !allowed.has(field))
            check(
              isDeepStrictEqual(actual, original),
              id,
              phase,
              'worker-baseline',
              `${context}.${field} differs from its raw-worker control`,
            );
          if (field === 'userAgent' && context === 'dedicated')
            check(
              isDeepStrictEqual(actual, page),
              id,
              phase,
              'worker-consistency',
              'Dedicated Worker UA differs from the document',
            );
          if (
            actual?.status === 'observed' &&
            page?.status === 'observed' &&
            !isDeepStrictEqual(actual, page)
          ) {
            if (allowed.has(field))
              exceptions.push({
                run: id,
                phase,
                check: 'explicit-override',
                detail: `${context}.${field}: measured difference allowed only for this opt-in configuration`,
              });
            else
              check(
                false,
                id,
                phase,
                'worker-consistency',
                `${context}.${field} differs from the document`,
              );
          }
        }
      }
      const life = sample.workers?.service?.lifecycle;
      check(
        life?.active === true && life.previousRegistration === (sample.lifecycle === 'controlled'),
        id,
        phase,
        'service-lifecycle',
        'Service Worker registration/activation did not match document history',
      );
      if (sample.lifecycle === 'controlled')
        check(
          life?.controlled === true && life.controllerState === 'activated',
          id,
          phase,
          'service-lifecycle',
          'Reload did not retain the active controlling Service Worker',
        );
      for (const context of ['document', ...contexts]) {
        const requests = evidence.requests.filter(
          (r) =>
            r.run === id &&
            r.context === context &&
            r.phase === sample.phase &&
            r.lifecycle === sample.lifecycle,
        );
        check(
          requests.length > 0,
          id,
          phase,
          'headers',
          `No ${context} request observed for this sample`,
        );
        const env =
          context === 'document' ? sample.environment : sample.workers?.[context]?.environment;
        for (const request of requests)
          check(
            request.headers?.['user-agent'] === env?.userAgent?.value,
            id,
            phase,
            'headers',
            `${context} HTTP UA differs from its navigator`,
          );
      }
    }
  }
  return {
    passed: failures.length === 0,
    checks,
    failures,
    exceptions,
    policy:
      'Required Chrome localhost samples, scoped cleanup, stable fields/descriptors and per-sample HTTP UA; no display/timing equality or detection claim.',
  };
}
