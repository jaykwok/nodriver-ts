// Preload only in the fixture-cleanup subprocess regression.
import { mock } from 'node:test';
import { ScriptedChrome } from '../../src/testing/index.ts';

mock.method(ScriptedChrome.prototype, 'connect', async () => {
  throw new Error('Injected scripted connection failure');
});
