import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Browser, EvaluationError, FetchCancelledError } from '../../src/index.ts';

test('tab.fetch runs in the page with its cookies and aborts the page request on cancel', async (t) => {
  const slow: { aborted?: boolean } = {};
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://x');
    if (url.pathname === '/page') {
      response.setHeader('set-cookie', 'sid=secret; Path=/; HttpOnly');
      response.setHeader('content-type', 'text/html');
      return response.end('<script>window.fetch = () => { throw new Error("patched") }</script>');
    }
    if (url.pathname === '/echo') {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('content-type', 'application/json');
      response.setHeader('x-answer', '42');
      return response.end(
        JSON.stringify({ method: request.method, cookie: request.headers.cookie, body }),
      );
    }
    if (url.pathname === '/bytes') return response.end(Buffer.from([0, 1, 254, 255]));
    if (url.pathname === '/big') return response.end('x'.repeat(2000));
    if (url.pathname === '/slow') {
      response.flushHeaders();
      request.on('close', () => (slow.aborted = !response.writableEnded));
      return;
    }
    response.statusCode = 404;
    response.end('missing');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await using browser = await Browser.launch({ headless: true });
  const tab = await browser.newTab(origin + '/page');

  const echo = await tab.fetch<{ method: string; cookie: string; body: string }>('/echo', {
    method: 'POST',
    body: 'hello',
    responseType: 'json',
  });
  assert.equal(echo.status, 200);
  assert.equal(echo.headers['x-answer'], '42');
  assert.deepEqual(echo.body, { method: 'POST', cookie: 'sid=secret', body: 'hello' });
  assert.equal((await tab.fetch('/missing')).status, 404);
  assert.equal((await tab.fetch('/bytes', { responseType: 'base64' })).body, 'AAH+/w==');
  await assert.rejects(tab.fetch('/big', { maxBytes: 1000 }), EvaluationError);

  const cancelled = await tab.fetch('/slow', { timeout: 500 }).catch((error: unknown) => error);
  assert.ok(cancelled instanceof FetchCancelledError);
  assert.equal(cancelled.aborted, true);
  const deadline = Date.now() + 5000;
  while (slow.aborted === undefined && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(slow.aborted, true);

  const controller = new AbortController();
  const stopped = tab
    .fetch('/slow', { signal: controller.signal })
    .catch((error: unknown) => error);
  setTimeout(() => controller.abort(new Error('stop')), 200);
  const error = await stopped;
  assert.ok(error instanceof FetchCancelledError && error.aborted);
  assert.match(String(error.cause), /stop/);
});
