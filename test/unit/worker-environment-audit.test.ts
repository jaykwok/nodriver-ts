import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summarizeWorkerEnvironment } from '../../benchmarks/worker-environment.ts';
import {
  workerContexts,
  type WorkerSample,
  type WorkerRequest,
} from '../../benchmarks/worker-environment-fixture.ts';

function evidence() {
  const samples: WorkerSample[] = workerContexts.map((kind) => ({
    run: 'test',
    kind,
    receivedAt: 1,
    initial: {
      userAgent: 'Native/1',
      language: 'en-US',
      languages: ['en-US'],
      locale: 'en-US',
      timezone: 'UTC',
      clientHints: { brands: [{ brand: 'Native', version: '1' }], platform: 'Test', mobile: false },
    },
    highEntropy: { status: 'observed', value: { architecture: 'x86', platformVersion: '1' } },
  }));
  const requests: WorkerRequest[] = workerContexts.flatMap((kind) =>
    [
      ['document', 'same-frame', 'cross-frame'].includes(kind) ? '/r/test/page' : '/worker.js',
      '/sample',
    ].map((path) => ({
      run: 'test',
      kind,
      path,
      receivedAt: 1,
      headers: { 'user-agent': 'Native/1', 'accept-language': 'en-US' },
    })),
  );
  return { samples, requests };
}
test('complete matching measurements preserve native absence of Worker HTTP client hints', () => {
  const { samples, requests } = evidence();
  const report = summarizeWorkerEnvironment(samples, requests);
  assert.deepEqual(report.missing, []);
  assert.deepEqual(report.missingRequests, []);
  assert.ok(report.comparisons.every((c) => c.status === 'match'));
  assert.ok(report.headers.every((h) => h.matchesFirstScriptUA));
  assert.ok(report.headers.every((h) => h.matchesFirstScriptLanguages));
  assert.deepEqual(report.headers.find((h) => h.kind === 'service')!.clientHints, {});
});
test('first-script and initial request discrepancies remain visible when later headers agree', () => {
  const { samples, requests } = evidence();
  samples.find((s) => s.kind === 'shared')!.initial.userAgent = 'Override/1';
  requests.find((r) => r.kind === 'shared' && r.path === '/sample')!.headers['user-agent'] =
    'Override/1';
  const report = summarizeWorkerEnvironment(samples, requests);
  assert.equal(
    report.comparisons.find((c) => c.kind === 'shared' && c.field === 'userAgent')!.status,
    'mismatch',
  );
  assert.equal(
    report.headers.find((h) => h.kind === 'shared' && h.path === '/worker.js')!
      .matchesFirstScriptUA,
    false,
  );
  assert.equal(
    report.headers.find((h) => h.kind === 'shared' && h.path === '/sample')!.matchesFirstScriptUA,
    true,
  );
});
test('initial language fallback differences survive a later matching header and a matching UA', () => {
  const { samples, requests } = evidence();
  requests.find((r) => r.kind === 'service' && r.path === '/worker.js')!.headers[
    'accept-language'
  ] = 'en-US,en;q=0.9';
  requests.find((r) => r.kind === 'service' && r.path === '/sample')!.headers['accept-language'] =
    'EN-us;q=1.0';
  const report = summarizeWorkerEnvironment(samples, requests);
  assert.ok(report.headers.every((h) => h.matchesFirstScriptUA));
  assert.equal(
    report.headers.find((h) => h.kind === 'service' && h.path === '/worker.js')!
      .matchesFirstScriptLanguages,
    false,
  );
  assert.equal(
    report.headers.find((h) => h.kind === 'service' && h.path === '/sample')!
      .matchesFirstScriptLanguages,
    true,
  );
});
test('missing contexts, initial requests and unavailable high entropy are never matches', () => {
  const { samples, requests } = evidence();
  const incomplete = samples.filter((s) => s.kind !== 'service');
  incomplete.find((s) => s.kind === 'shared')!.highEntropy = {
    status: 'unavailable',
    error: 'blocked',
  };
  const report = summarizeWorkerEnvironment(
    incomplete,
    requests.filter((r) => r.kind !== 'nested' || r.path !== '/worker.js'),
  );
  assert.deepEqual(report.missing, ['service']);
  assert.deepEqual(report.missingRequests, ['nested/initial']);
  assert.ok(
    report.headers
      .filter((h) => h.kind === 'service')
      .every((h) => h.matchesFirstScriptUA === null),
  );
  assert.equal(
    report.comparisons.find((c) => c.kind === 'shared' && c.field === 'highEntropy (asynchronous)')!
      .status,
    'unavailable',
  );
});
test('client hints compare object keys semantically but retain brand array order', () => {
  const { samples, requests } = evidence();
  for (const sample of samples)
    (sample.initial.clientHints as { brands: unknown[] }).brands.push({
      brand: 'Other',
      version: '2',
    });
  samples.find((s) => s.kind === 'shared')!.initial.clientHints = {
    mobile: false,
    platform: 'Test',
    brands: [
      { version: '1', brand: 'Native' },
      { version: '2', brand: 'Other' },
    ],
  };
  samples.find((s) => s.kind === 'nested')!.initial.clientHints = {
    mobile: false,
    platform: 'Test',
    brands: [
      { version: '2', brand: 'Other' },
      { version: '1', brand: 'Native' },
    ],
  };
  const report = summarizeWorkerEnvironment(samples, requests);
  assert.equal(
    report.comparisons.find((c) => c.kind === 'shared' && c.field === 'clientHints')!.status,
    'match',
  );
  assert.equal(
    report.comparisons.find((c) => c.kind === 'nested' && c.field === 'clientHints')!.status,
    'mismatch',
  );
});
