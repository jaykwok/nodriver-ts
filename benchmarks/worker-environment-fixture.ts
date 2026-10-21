import { readFile } from 'node:fs/promises';
import { serve } from '../test/fixtures/serve.ts';
import { poll } from '../src/utils.ts';

export const workerContexts = [
  'document',
  'same-frame',
  'cross-frame',
  'dedicated',
  'nested',
  'shared',
  'service',
] as const;
export interface WorkerSample {
  run: string;
  kind: string;
  receivedAt: number;
  initial: {
    userAgent: string;
    language: string;
    languages: string[];
    locale: string;
    timezone: string;
    clientHints: unknown;
  };
  highEntropy: { status: string; value?: unknown; error?: string };
}
export interface WorkerRequest {
  run: string;
  kind: string;
  path: string;
  receivedAt: number;
  headers: Record<string, string>;
}

export async function workerEnvironmentFixture() {
  const code = await readFile(new URL('./audit/worker-environment.js', import.meta.url), 'utf8');
  const samples: WorkerSample[] = [],
    requests: WorkerRequest[] = [];
  const failures: Array<{ run: string; kind: string; error: string }> = [];
  const server = await serve({
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const run = url.searchParams.get('run') ?? '';
      const kind = url.searchParams.get('kind') ?? '';
      const receivedAt = performance.now();
      requests.push({
        run,
        kind,
        path: url.pathname,
        receivedAt,
        headers: Object.fromEntries(request.headers),
      });
      if (url.pathname === '/sample') {
        samples.push({
          ...((await request.json()) as Omit<WorkerSample, 'run' | 'kind' | 'receivedAt'>),
          run,
          kind,
          receivedAt,
        });
        return new Response('ok');
      }
      if (url.pathname === '/failure') {
        failures.push({ run, kind, error: await request.text() });
        return new Response('ok');
      }
      const headers = {
        'cache-control': 'no-store',
        'accept-ch':
          'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness',
      };
      if (url.pathname === '/worker.js')
        return new Response(code, {
          headers: { ...headers, 'content-type': 'text/javascript', 'service-worker-allowed': '/' },
        });
      if (url.pathname.startsWith('/r/'))
        return new Response(
          `<!doctype html><meta charset="utf-8"><title>Worker environment audit</title><body><script>${code}</script>`,
          { headers: { ...headers, 'content-type': 'text/html; charset=utf-8' } },
        );
      return new Response('not found', { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  return {
    origin,
    owns(url: string) {
      try {
        const parsed = new URL(url);
        return (
          parsed.protocol === 'http:' &&
          parsed.port === String(server.port) &&
          ['127.0.0.1', 'localhost'].includes(parsed.hostname)
        );
      } catch {
        return false;
      }
    },
    samples,
    requests,
    async wait(run: string) {
      return poll(
        async () => {
          const failure = failures.find((f) => f.run === run);
          if (failure) throw new Error(`${failure.kind}: ${failure.error}`);
          const found = samples.filter((s) => s.run === run);
          return workerContexts.every((kind) => found.some((s) => s.kind === kind))
            ? found
            : undefined;
        },
        { timeout: 15000 },
        `${run}: first-script samples from all seven contexts`,
      );
    },
    close: () => server.stop(),
  };
}
