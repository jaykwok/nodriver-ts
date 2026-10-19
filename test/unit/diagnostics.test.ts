import { test } from 'node:test';
import { expect } from '../fixtures/expect.ts';
import { alignEnvironment } from '../../src/page/diagnostics.ts';
import type { Tab } from '../../src/page/tab.ts';
test('GeoIP resolver is opt-in and bounded; cancellation never applies a late result', async () => {
  let applied = 0;
  const tab = {
    diagnoseEnvironment: async () => ({ frames: [] }),
    setEnvironment: async () => {
      applied++;
    },
  } as unknown as Tab;
  await expect(
    alignEnvironment(tab, { geoip: { address: 'local-fixture', fields: ['timezone'] } }),
  ).rejects.toThrow('caller-supplied');
  await expect(
    alignEnvironment(
      tab,
      { geoip: { address: 'local-fixture', fields: ['timezone'] }, timeout: 20 },
      async () => new Promise(() => {}),
    ),
  ).rejects.toThrow('deadline');
  expect(applied).toBe(0);
});
