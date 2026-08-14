import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';

import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { createHTTPHandler } from '@trpc/server/adapters/standalone';
import { chromium } from 'playwright';

import {
  appRouter,
  resetAuthoritative,
  setProtocolAvailable,
  type AppRouter,
} from '../src/router.js';

test('Chrome service worker replays two durable lanes and pulls server changes', { timeout: 120_000 }, async (t) => {
  resetAuthoritative();
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    if (process.env.OPTO_SYNC_REQUIRE_BROWSER === '1') throw error;
    t.skip('headless Chromium is unavailable locally');
    return;
  }
  t.after(() => browser.close());

  const [pageBundle, workerBundle] = await Promise.all([
    readFile('.build/web/page.js'),
    readFile('.build/web/sw.js'),
  ]);
  const trpcHandler = createHTTPHandler({ router: appRouter, basePath: '/trpc/' });
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/trpc/')) {
      trpcHandler(request, response);
      return;
    }
    if (request.url === '/page.js' || request.url === '/sw.js') {
      response.writeHead(200, {
        'content-type': 'text/javascript; charset=utf-8',
        'cache-control': 'no-store',
        ...(request.url === '/sw.js' ? { 'service-worker-allowed': '/' } : {}),
      });
      response.end(request.url === '/sw.js' ? workerBundle : pageBundle);
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end('<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const rpc = createTRPCClient<AppRouter>({
    links: [httpBatchLink({ url: `${origin}/trpc` })],
  });

  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  await page.goto(origin, { waitUntil: 'load' });
  await page.evaluate(() => window.optoTest.initialize());

  setProtocolAvailable(false);
  await page.evaluate(() => window.optoTest.queueMultiplexedEdits());
  const unavailable = await page.evaluate(() => window.optoTest.wakeWorker()) as { ok: boolean };
  assert.equal(unavailable.ok, false, 'the failed drain must remain browser-retryable');

  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  setProtocolAvailable(true);

  const recovered = await page.evaluate(() => window.optoTest.wakeWorker()) as {
    ok: boolean;
    result: { pushedMutations: number; acknowledgedMutations: number; pulledChanges: number };
  };
  assert.equal(recovered.ok, true);
  assert.equal(recovered.result.pushedMutations, 2);
  assert.equal(recovered.result.acknowledgedMutations, 2);
  assert.equal(recovered.result.pulledChanges, 2);

  const first = await page.evaluate(() => window.optoTest.authoritativeRecord('documents/doc-1')) as {
    title: string;
    metadata: Record<string, unknown>;
  };
  const second = await page.evaluate(() => window.optoTest.authoritativeRecord('documents/doc-2')) as {
    title: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(first.title, 'offline edit from web lane one');
  assert.equal(second.title, 'offline edit from web lane two');
  assert.deepEqual(first.metadata, { serverOnly: true, webLane: 'one' });
  assert.deepEqual(second.metadata, { serverOnly: true, webLane: 'two' });

  await rpc.serverEdit.mutate({
    id: 'doc-1',
    title: 'server broadcast after reconnect',
    updatedAt: '300',
    metadata: { serverBroadcast: true },
  });
  const pulled = await page.evaluate(() => window.optoTest.wakeWorker()) as {
    ok: boolean;
    result: { pushedMutations: number; pulledChanges: number };
  };
  assert.equal(pulled.ok, true);
  assert.equal(pulled.result.pushedMutations, 0);
  assert.equal(pulled.result.pulledChanges, 1);
  const updated = await page.evaluate(() => window.optoTest.authoritativeRecord('documents/doc-1')) as {
    title: string;
    metadata: Record<string, unknown>;
  };
  assert.equal(updated.title, 'server broadcast after reconnect');
  assert.deepEqual(updated.metadata, {
    serverOnly: true,
    webLane: 'one',
    serverBroadcast: true,
  });
  await cdp.detach();
});
