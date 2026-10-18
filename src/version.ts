import { readFileSync } from 'node:fs';

/** Package name and version, read once from package.json (works from src/ and dist/). */
export const PACKAGE = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { name: string; version: string };
