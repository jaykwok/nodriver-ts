// The package's ESM entry default-imports its CommonJS build. Bun resolves that default import to
// `exports.default` (the build sets __esModule) instead of `module.exports`, leaving the named
// exports undefined, so load the CommonJS build directly on both runtimes.
import { createRequire } from 'node:module';

export const { expect } = createRequire(import.meta.url)('expect') as typeof import('expect');
