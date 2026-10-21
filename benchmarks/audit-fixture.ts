import { readFile } from 'node:fs/promises';
import { serve } from '../test/fixtures/serve.ts';
import { poll } from '../src/utils.ts';

export async function auditFixture() {
  const code = await readFile(new URL('./audit/page.js', import.meta.url), 'utf8');
  const reports: Array<Record<string, any>> = [];
  const headers: Array<Record<string, unknown>> = [];
  const commands = new Map<string, string>();
  const server = await serve({
    hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      const run = url.searchParams.get('run') ?? '';
      if (url.pathname === '/report') {
        reports.push({
          ...((await request.json()) as Record<string, any>),
          receivedAt: performance.now(),
        });
        return new Response('ok');
      }
      if (url.pathname === '/command') {
        const phase = commands.get(run);
        commands.delete(run);
        return Response.json({ phase });
      }
      if (url.pathname === '/probe.js')
        return new Response(code, {
          headers: {
            'content-type': 'text/javascript',
            'service-worker-allowed': '/',
            'cache-control': 'no-store',
          },
        });
      headers.push({
        run,
        context: url.searchParams.get('context') ?? 'navigation',
        phase: url.searchParams.get('phase'),
        lifecycle: url.searchParams.get('lifecycle'),
        path: url.pathname,
        receivedAt: performance.now(),
        headers: Object.fromEntries(request.headers),
      });
      if (url.pathname === '/headers') return Response.json({ ok: true });
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Local differential audit</title><input id="name"><button id="click" onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1)">Click</button><p>Manual collector controls (present in every group): <button id="manual-capture">Record physical sample</button><label><input type="checkbox" id="physical-attest">I used a physical keyboard/mouse</label><button id="manual-finish">Finish manual collection</button></p><div style="height:1800px">Scroll fixture</div><script src="/probe.js"></script>',
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'accept-ch':
              'Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Bitness',
            'cache-control': 'no-store',
          },
        },
      );
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  async function wait(run: string, phase: string, start = 0) {
    return poll(
      async () => {
        const error = reports.slice(start).find((r) => r.run === run && r.phase === 'probe-error');
        if (error) throw new Error(error.error);
        return reports.slice(start).find((r) => r.run === run && r.phase === phase);
      },
      { timeout: 20000 },
      `${run} ${phase}`,
    );
  }
  async function sample(run: string, phase: string) {
    const start = reports.length;
    commands.set(run, phase);
    return wait(run, phase, start);
  }
  return { origin, reports, headers, commands, wait, sample, close: () => server.stop() };
}
