// Preload only in the fixture-cleanup subprocess regression. No Chrome is launched.
import { mock } from 'node:test';
import { Browser } from '../../src/index.ts';

mock.method(Browser, 'launch', async () => {
  throw new Error('Injected browser startup failure');
});
