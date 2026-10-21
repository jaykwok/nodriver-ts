import { isDeepStrictEqual } from 'node:util';

/** Summaries preserve missing fields and avoid turning any difference into a verdict. */
export function summarizeAudit(
  runs: Array<Record<string, any>>,
  reports: Array<Record<string, any>>,
  headers: Array<Record<string, any>>,
) {
  const initial = (id: string) => reports.find((r) => r.run === id && r.phase === 'ready');
  const summaries = runs.map((run) => {
    const samples = reports.filter((r) => r.run === run.run && r.environment);
    const requestObservations = ['document', 'dedicated', 'shared', 'service'].map((context) => {
      const requests = headers.filter((h) => h.run === run.run && h.context === context);
      return {
        context,
        status: requests.length ? 'observed' : 'not-observed',
        requests: requests.map((r) => {
          const values = r.headers as Record<string, string>;
          const sample = samples.find((s) => s.phase === r.phase && s.lifecycle === r.lifecycle);
          const environment =
            context === 'document' ? sample?.environment : sample?.workers?.[context]?.environment;
          return {
            phase: r.phase,
            lifecycle: r.lifecycle,
            userAgent: values['user-agent'] ?? null,
            matchesContextNavigator:
              environment?.userAgent?.status === 'observed'
                ? values['user-agent'] === environment.userAgent.value
                : null,
            clientHints: Object.fromEntries(
              [
                'sec-ch-ua',
                'sec-ch-ua-platform',
                'sec-ch-ua-full-version-list',
                'sec-ch-ua-platform-version',
                'sec-ch-ua-arch',
                'sec-ch-ua-bitness',
              ].map((key) => [
                key,
                values[key] === undefined
                  ? { status: 'not-observed' }
                  : { status: 'observed', value: values[key] },
              ]),
            ),
          };
        }),
      };
    });
    return {
      run: run.run,
      requestObservations,
      timing: samples.map((s) => ({ phase: s.phase, lifecycle: s.lifecycle, ...s.timing })),
      domainCommands: run.domains ?? [],
      cleanup: reports.find((r) => r.run === run.run && r.phase === 'cleanup'),
    };
  });
  const stageDifferences = runs.map((run) => {
    if (run.stage === 'A-native') return { run: run.run, status: 'baseline' };
    const attached = run.stage === 'D-attached';
    const control = attached
      ? run.run
      : run.stage === 'A-matched'
        ? `A-native-${run.repeat}`
        : run.stage === 'B-endpoint'
          ? `A-matched-${run.repeat}`
          : run.stage === 'C-raw'
            ? `B-endpoint-${run.repeat}`
            : run.variant?.name === 'default-native'
              ? `C-raw-${run.repeat}`
              : `D-E-${run.transport}-default-native-${run.repeat}`;
    const before =
      run.stage === 'C-raw'
        ? reports.find((r) => r.run === control && r.phase === 'after-connect-control')
        : initial(control);
    const after =
      run.stage === 'C-raw' || attached
        ? reports.find((r) => r.run === run.run && r.phase === 'after-connect-control')
        : initial(run.run);
    if (!before || !after) return { run: run.run, control, status: 'not-available' };
    const environmentFields = Object.keys(after.environment).filter(
      (key) => !isDeepStrictEqual(after.environment[key], before.environment[key]),
    );
    const descriptors = Object.fromEntries(
      ['navigator', 'navigatorOwn', 'window', 'chrome'].map((object) => [
        object,
        [
          ...new Set([
            ...Object.keys(before.properties[object] ?? {}),
            ...Object.keys(after.properties[object] ?? {}),
          ]),
        ].filter(
          (key) =>
            !isDeepStrictEqual(before.properties[object]?.[key], after.properties[object]?.[key]),
        ),
      ]),
    );
    return {
      run: run.run,
      control,
      status: 'observed',
      beforePhase: `${before.phase}/${before.lifecycle}`,
      afterPhase: `${after.phase}/${after.lifecycle}`,
      environmentFields,
      descriptors,
      addedGlobals: after.properties.globals.filter(
        (key: string) => !before.properties.globals.includes(key),
      ),
      removedGlobals: before.properties.globals.filter(
        (key: string) => !after.properties.globals.includes(key),
      ),
      qualification: attached
        ? 'Same loaded document before and after Browser.connect initialization, without navigation or input. Scheduling, timing and focus are observations, not detection verdicts.'
        : 'Observations under recorded conditions, not detection verdicts. Pipe D and its raw WebSocket control differ in transport. Launched D loads its page after initialization; C connects after initial ready. Startup page history is recorded, not claimed equivalent.',
    };
  });
  return { summaries, stageDifferences };
}
